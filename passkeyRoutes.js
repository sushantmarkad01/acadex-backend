// backend/passkeyRoutes.js
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const db = admin.firestore();

// ---------------------------
// 🔥 IMPORTANT CONFIG
// ---------------------------

// Your DEPLOYED FRONTEND domain
const ORIGIN = 'https://scheduplan-1b51d.web.app';

// RP ID MUST match frontend domain (NO https://)
const RP_ID = 'scheduplan-1b51d.web.app';

// Temporary challenge store (use Redis for production)
const challengeStore = {};


// ------------------------------------------------
// 1️⃣ PASSKEY REGISTRATION (START)
// ------------------------------------------------
router.get('/register-start', async (req, res) => {
  const { userId } = req.query;

  const userDoc = await db.collection('users').doc(userId).get();
  const user = userDoc.data();

  const options = await generateRegistrationOptions({
    rpName: 'AcadeX',
    rpID: RP_ID,
    userID: userId,
    userName: user.email || 'User',

    // Pass previously registered credential IDs to prevent duplicates
    excludeCredentials: (user?.authenticators || []).map(auth => ({
      id: Buffer.from(auth.credentialID, 'base64url'),
      type: 'public-key',
    })),

    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
      authenticatorAttachment: 'platform',
    },
  });

  challengeStore[userId] = options.challenge;

  // Auto-expire challenge after 2 minutes for safety
  setTimeout(() => {
    delete challengeStore[userId];
  }, 1000 * 120);

  res.json(options);
});


// ------------------------------------------------
// 2️⃣ PASSKEY REGISTRATION (FINISH)
// ------------------------------------------------
router.post('/register-finish', async (req, res) => {
  const { userId, data } = req.body;
  const expectedChallenge = challengeStore[userId];

  if (!expectedChallenge)
    return res.status(400).json({ error: 'Challenge expired' });

  try {
    const verification = await verifyRegistrationResponse({
      response: data,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified) {
      return res.status(400).json({ verified: false });
    }

    const { registrationInfo } = verification;

    const newAuthenticator = {
      credentialID: registrationInfo.credentialID.toString('base64url'),
      credentialPublicKey: registrationInfo.credentialPublicKey.toString('base64'),
      counter: registrationInfo.counter,
      transports: registrationInfo.transports || [],
    };

    await db.collection('users').doc(userId).update({
      authenticators: admin.firestore.FieldValue.arrayUnion(newAuthenticator)
    });

    delete challengeStore[userId];

    res.json({ verified: true });

  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});


// ------------------------------------------------
// 3️⃣ PASSKEY LOGIN (START)
// ------------------------------------------------
router.get('/login-start', async (req, res) => {
  const { userId } = req.query;

  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists)
    return res.status(404).json({ error: 'User not found' });

  const user = userDoc.data();

  if (!user.authenticators || user.authenticators.length === 0) {
    return res.status(400).json({ error: 'No passkeys registered' });
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: user.authenticators.map(auth => ({
      id: Buffer.from(auth.credentialID, 'base64url'),
      type: 'public-key',
    })),
    userVerification: 'preferred',
  });

  challengeStore[userId] = options.challenge;

  // Auto delete challenge
  setTimeout(() => {
    delete challengeStore[userId];
  }, 1000 * 120);

  res.json(options);
});


// ------------------------------------------------
// 4️⃣ PASSKEY LOGIN (FINISH)
// ------------------------------------------------
router.post('/login-finish', async (req, res) => {
  const { userId, data } = req.body;

  const userDoc = await db.collection('users').doc(userId).get();
  const user = userDoc.data();

  const expectedChallenge = challengeStore[userId];
  if (!expectedChallenge)
    return res.status(400).json({ error: 'Challenge expired' });

  // Find matching authenticator
  const authenticatorEntry = user.authenticators.find(auth =>
    auth.credentialID === data.id
  );

  if (!authenticatorEntry)
    return res.status(400).json({ error: 'Authenticator not found' });

  const authenticator = {
    ...authenticatorEntry,
    credentialPublicKey: Buffer.from(authenticatorEntry.credentialPublicKey, 'base64'),
  };

  try {
    const verification = await verifyAuthenticationResponse({
      response: data,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      authenticator,
    });

    if (!verification.verified) {
      return res.status(400).json({ verified: false });
    }

    // Update replay counter
    const updatedAuths = user.authenticators.map(auth => {
      if (auth.credentialID === data.id) {
        return { ...auth, counter: verification.authenticationInfo.newCounter };
      }
      return auth;
    });

    await db.collection('users').doc(userId).update({
      authenticators: updatedAuths,
    });

    delete challengeStore[userId];

    res.json({ verified: true });

  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});


module.exports = router;
