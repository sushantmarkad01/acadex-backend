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

// 🚨 MUST MATCH YOUR FRONTEND URL EXACTLY
const RP_ID = 'scheduplan-1b51d.web.app'; 
const ORIGIN = 'https://scheduplan-1b51d.web.app'; 

const challengeStore = {}; 

// 1. REGISTRATION (SETUP)
router.get('/register-start', async (req, res) => {
    const { userId } = req.query;
    if(!userId) return res.status(400).json({ error: "User ID required" });
    
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
        const user = userDoc.data() || {};

        // Generate options (Simplified to prevent crashes)
        const options = await generateRegistrationOptions({
            rpName: 'AcadeX App',
            rpID: RP_ID,
            userID: String(userId),
            userName: user.email || 'User',
            // We temporarily remove 'excludeCredentials' to stop the 500 crash
            authenticatorSelection: {
                residentKey: 'preferred',
                userVerification: 'preferred',
                authenticatorAttachment: 'platform', 
            },
        });

        challengeStore[userId] = options.challenge;
        res.json(options);

    } catch (error) {
        console.error("🔥 REGISTRATION ERROR:", error);
        // This will print the REAL error to your Render logs
        res.status(500).json({ error: error.message });
    }
});

// 2. VERIFY REGISTRATION
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

            const newAuthenticator = {
                credentialID: registrationInfo.credentialID,
                credentialPublicKey: registrationInfo.credentialPublicKey.toString('base64'),
                counter: registrationInfo.counter,
            };

            await db.collection('users').doc(userId).update({
                authenticators: admin.firestore.FieldValue.arrayUnion(newAuthenticator)
            });

            delete challengeStore[userId];
            res.json({ verified: true });
        } else {
            res.status(400).json({ verified: false });
        }
    } catch (error) {
        console.error("🔥 VERIFY ERROR:", error);
        res.status(400).json({ error: error.message });
    }
});

// 3. LOGIN START
router.get('/login-start', async (req, res) => {
    const { userId } = req.query;
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
        const user = userDoc.data();

        // Safety check for empty authenticators
        if (!user.authenticators || user.authenticators.length === 0) {
            return res.status(400).json({ error: 'No passkeys registered' });
        }

        const options = await generateAuthenticationOptions({
            rpID: RP_ID,
            // Only map if valid
            allowCredentials: user.authenticators.map(auth => ({
                id: auth.credentialID,
                type: 'public-key',
            })),
            userVerification: 'preferred',
        });

        challengeStore[userId] = options.challenge;
        res.json(options);
    } catch (error) {
        console.error("🔥 LOGIN START ERROR:", error);
        res.status(500).json({ error: error.message });
    }
});

// 4. LOGIN FINISH
router.post('/login-finish', async (req, res) => {
    const { userId, data } = req.body;
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        const user = userDoc.data();
        const expectedChallenge = challengeStore[userId];
        
        const authData = user.authenticators.find(auth => auth.credentialID === data.id);
        if (!authData) return res.status(400).send('Authenticator not found');

        const authenticator = {
            ...authData,
            credentialPublicKey: Buffer.from(authData.credentialPublicKey, 'base64')
        };

        const verification = await verifyAuthenticationResponse({
            response: data,
            expectedChallenge,
            expectedOrigin: ORIGIN,
            expectedRPID: RP_ID,
            authenticator,
        });

        if (verification.verified) {
            // Update counter
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
        console.error("🔥 LOGIN FINISH ERROR:", error);
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;
