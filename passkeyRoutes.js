// backend/passkeyRoutes.js
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin'); // Uses your existing Firebase Admin
const { 
  generateRegistrationOptions, 
  verifyRegistrationResponse, 
  generateAuthenticationOptions, 
  verifyAuthenticationResponse 
} = require('@simplewebauthn/server');

const db = admin.firestore();

// CONSTANTS (Update these for production!)
const RP_ID = 'acadex-backend-n2wh.onrender.com'; // Your Render backend domain (without https://)
// For local testing use: 'localhost' 
const ORIGIN = 'https://acadex-app.onrender.com'; // Your Frontend URL
// For local testing use: 'http://localhost:3000'

// Temp memory to store challenges (In production, use Redis or DB)
const challengeStore = {}; 

// --- 1. REGISTRATION (SETUP) ---

router.get('/register-start', async (req, res) => {
    const { userId } = req.query;
    
    // Get user from Firestore to check if they already have authenticators
    const userDoc = await db.collection('users').doc(userId).get();
    const user = userDoc.data();

    // 1. Generate Registration Options
    const options = await generateRegistrationOptions({
        rpName: 'AcadeX',
        rpID: RP_ID,
        userID: userId,
        userName: user.email || 'User',
        // Prevent registering the same finger twice
        excludeCredentials: (user.authenticators || []).map(auth => ({
            id: auth.credentialID,
            type: 'public-key',
        })),
        authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred',
            authenticatorAttachment: 'platform', // Forces TouchID/FaceID
        },
    });

    // 2. Save challenge temporarily
    challengeStore[userId] = options.challenge;

    res.json(options);
});

router.post('/register-finish', async (req, res) => {
    const { userId, data } = req.body;
    const expectedChallenge = challengeStore[userId];

    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired' });

    try {
        const verification = await verifyRegistrationResponse({
            response: data,
            expectedChallenge,
            expectedOrigin: ORIGIN,
            expectedRPID: RP_ID,
        });

        if (verification.verified) {
            const { registrationInfo } = verification;

            // Prepare key for Firestore (Convert Buffer to Base64)
            const newAuthenticator = {
                credentialID: registrationInfo.credentialID,
                credentialPublicKey: registrationInfo.credentialPublicKey.toString('base64'),
                counter: registrationInfo.counter,
                transports: registrationInfo.transports || []
            };

            // Save to "users" collection
            await db.collection('users').doc(userId).update({
                authenticators: admin.firestore.FieldValue.arrayUnion(newAuthenticator)
            });

            delete challengeStore[userId]; // Cleanup
            res.json({ verified: true });
        } else {
            res.status(400).json({ verified: false });
        }
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: error.message });
    }
});

// --- 2. AUTHENTICATION (LOGIN) ---

router.get('/login-start', async (req, res) => {
    const { userId } = req.query;
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const user = userDoc.data();

    if (!user.authenticators || user.authenticators.length === 0) {
        return res.status(400).json({ error: 'No passkeys registered' });
    }

    const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials: user.authenticators.map(auth => ({
            id: auth.credentialID,
            type: 'public-key',
        })),
        userVerification: 'preferred',
    });

    challengeStore[userId] = options.challenge;
    res.json(options);
});

router.post('/login-finish', async (req, res) => {
    const { userId, data } = req.body;
    const userDoc = await db.collection('users').doc(userId).get();
    const user = userDoc.data();
    
    const expectedChallenge = challengeStore[userId];
    
    // Find the authenticator used
    const authenticatorBase64 = user.authenticators.find(auth => auth.credentialID === data.id);
    if (!authenticatorBase64) return res.status(400).send('Authenticator not found');

    // Convert Base64 back to Buffer for library
    const authenticator = {
        ...authenticatorBase64,
        credentialPublicKey: Buffer.from(authenticatorBase64.credentialPublicKey, 'base64')
    };

    try {
        const verification = await verifyAuthenticationResponse({
            response: data,
            expectedChallenge,
            expectedOrigin: ORIGIN,
            expectedRPID: RP_ID,
            authenticator,
        });

        if (verification.verified) {
            // Update counter to prevent replay attacks
            const updatedAuths = user.authenticators.map(auth => {
                if (auth.credentialID === data.id) {
                    return { ...auth, counter: verification.authenticationInfo.newCounter };
                }
                return auth;
            });
            await db.collection('users').doc(userId).update({ authenticators: updatedAuths });

            delete challengeStore[userId];
            res.json({ verified: true });
        } else {
            res.status(400).json({ verified: false });
        }
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;
