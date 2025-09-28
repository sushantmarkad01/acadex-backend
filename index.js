const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

app.post('/createUser', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, instituteId, extras } = req.body;

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

    // 4. ✅ NEW: Generate a password reset link and send the email
    // This allows the user to set their own password securely
    const link = await admin.auth().generatePasswordResetLink(email);
    // In a real app, you would use an email service here. For the hackathon,
    // this link will be logged in your Render backend logs for you to see.
    console.log(`Password reset link for ${email}: ${link}`);

    res.status(200).send({ 
        message: `Success! User ${email} was created. A password reset link has been generated.` 
    });

  } catch (error) {
    console.error("Error creating new user:", error);
    res.status(500).send({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});