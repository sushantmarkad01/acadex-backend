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

// -------------------------------------------------------------------------
// 🚨 CRITICAL CONFIGURATION (Must match your Frontend exactly)
// -------------------------------------------------------------------------
// The domain of your frontend (where the user is physically looking)
const RP_ID = 'scheduplan-1b51d.web.app'; 

// The full URL of your frontend (must include https://)
const ORIGIN = 'https://scheduplan-1b51d.web.app'; 
// -------------------------------------------------------------------------

// Temp memory to store challenges (In production, use Redis or DB if server restarts often)
const challengeStore = {}; 

// ==========================================
// 1. REGISTRATION (SETUP FINGERPRINT)
// ==========================================

router.get('/register-start', async (req, res) => {
    const { userId } = req.query;
    if(!userId) return res.status(400).json({ error: "User ID required" });
    
    try {
        // Get user from Firestore
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
        const user = userDoc.data();

        // Generate Options
        const options = await generateRegistrationOptions({
            rpName: 'AcadeX App',
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
                authenticatorAttachment: 'platform', // Forces TouchID/FaceID/Windows Hello
            },
        });

        // Save challenge temporarily
        challengeStore[userId] = options.challenge;
        
        res.json(options);
    } catch (error) {
        console.error("Reg Start Error:", error);
        res.status(500).json({ error: error.message });
    }
});

router.post('/register-finish', async (req, res) => {
    const { userId, data } = req.body;
    const expectedChallenge = challengeStore[userId];

    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired or invalid' });

    try {
        const verification = await verifyRegistrationResponse({
            response: data,
            expectedChallenge,
            expectedOrigin: ORIGIN,
            expectedRPID: RP_ID,
        });

        if (verification.verified) {
            const { registrationInfo } = verification;

            // Prepare key for Firestore (Convert Buffer to Base64 string for storage)
            const newAuthenticator = {
                credentialID: registrationInfo.credentialID,
                credentialPublicKey: registrationInfo.credentialPublicKey.toString('base64'),
                counter: registrationInfo.counter,
                transports: registrationInfo.transports || []
            };

            // Save to "users" collection in Firebase
            await db.collection('users').doc(userId).update({
                authenticators: admin.firestore.FieldValue.arrayUnion(newAuthenticator)
            });

            delete challengeStore[userId]; // Cleanup
            res.json({ verified: true });
        } else {
            res.status(400).json({ verified: false, error: "Verification failed" });
        }
    } catch (error) {
        console.error("Reg Finish Error:", error);
        res.status(400).json({ error: error.message });
    }
});

// ==========================================
// 2. AUTHENTICATION (LOGIN WITH FINGERPRINT)
// ==========================================

router.get('/login-start', async (req, res) => {
    const { userId } = req.query;
    
    try {
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
    } catch (error) {
        console.error("Login Start Error:", error);
        res.status(500).json({ error: error.message });
    }
});

router.post('/login-finish', async (req, res) => {
    const { userId, data } = req.body;
    
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        const user = userDoc.data();
        
        const expectedChallenge = challengeStore[userId];
        
        // Find the authenticator used in our DB
        const authenticatorBase64 = user.authenticators.find(auth => auth.credentialID === data.id);
        if (!authenticatorBase64) return res.status(400).send('Authenticator not found');

        // Convert Base64 string back to Buffer for the library
        const authenticator = {
            ...authenticatorBase64,
            credentialPublicKey: Buffer.from(authenticatorBase64.credentialPublicKey, 'base64')
        };

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
        console.error("Login Finish Error:", error);
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;
