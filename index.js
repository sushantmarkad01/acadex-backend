const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors({ origin: true })); // Allow requests from your frontend
app.use(express.json());

// --- IMPORTANT: Firebase Admin SDK Setup ---
// 1. Go to your Firebase Project Settings -> Service accounts.
// 2. Click "Generate new private key" and download the JSON file.
// 3. Rename the file to "serviceAccountKey.json" and place it in this `backend` folder.
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// The secure API endpoint for creating users
app.post('/createUser', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, instituteId, extras } = req.body;

    // TODO: Add a security check here to ensure the request is from an authenticated institute admin.
    // For the hackathon, we are keeping it simple.

    // 1. Create the user in Firebase Authentication
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: `${firstName} ${lastName}`,
    });

    // 2. Create the user's profile in Firestore
    const userProfile = {
      uid: userRecord.uid,
      email,
      role,
      instituteId,
      firstName,
      lastName,
      ...extras,
    };
    await admin.firestore().collection('users').doc(userRecord.uid).set(userProfile);
        
    // 3. Set a custom role for security rules
    await admin.auth().setCustomUserClaims(userRecord.uid, { role, instituteId });

    res.status(200).send({ message: `Success! User ${email} was created.` });

  } catch (error) {
    console.error("Error creating new user:", error);
    res.status(500).send({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});