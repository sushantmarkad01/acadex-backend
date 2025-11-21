const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const nodemailer = require('nodemailer'); 
require('dotenv').config(); 
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// --- CONFIG ---
const transporter = nodemailer.createTransport({
  service: 'gmail', 
  auth: {
    user: process.env.EMAIL_USER, 
    pass: process.env.EMAIL_PASS  
  }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function initFirebaseAdmin() {
  const svcEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svcEnv) {
    try {
      const svcJson = (/^[A-Za-z0-9+/=]+\s*$/.test(svcEnv) && svcEnv.length > 1000)
        ? JSON.parse(Buffer.from(svcEnv, 'base64').toString('utf8'))
        : JSON.parse(svcEnv);
      admin.initializeApp({ credential: admin.credential.cert(svcJson) });
      console.log("Firebase Admin initialized from env var.");
      return;
    } catch (err) { console.error(err); process.exit(1); }
  }
  try {
    const local = require('./serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(local) });
  } catch (err) { console.error(err); process.exit(1); }
}
initFirebaseAdmin();

const DEMO_MODE = (process.env.DEMO_MODE || 'true') === 'true';

// --- ROUTES ---

app.get('/health', (req, res) => res.json({ status: 'ok', demoMode: DEMO_MODE }));

// 1. Create User (FAST VERSION)
app.post('/createUser', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, instituteId, instituteName, department, subject, rollNo, qualification, extras = {} } = req.body;
    
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`
    });

    const userDoc = {
      uid: userRecord.uid,
      email,
      role, 
      firstName,
      lastName,
      instituteId,
      instituteName,
      department: department || null,
      // ✅ Saving Subject & RollNo correctly
      subject: subject || null, 
      rollNo: rollNo || null,
      qualification: qualification || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      ...extras
    };

    await admin.firestore().collection('users').doc(userRecord.uid).set(userDoc);
    await admin.auth().setCustomUserClaims(userRecord.uid, { role, instituteId });

    // ✅ BACKGROUND EMAIL (Don't wait for it!)
    admin.auth().generatePasswordResetLink(email)
        .then(link => {
            const mailOptions = {
                from: '"AcadeX Admin" <' + process.env.EMAIL_USER + '>',
                to: email,
                subject: 'Welcome to AcadeX',
                html: `<p>Hello ${firstName}, your account is ready. <a href="${link}">Set Password</a></p>`
            };
            transporter.sendMail(mailOptions).catch(e => console.error("Email failed:", e));
        })
        .catch(e => console.error("Link generation failed:", e));

    // Return Success IMMEDIATELY
    return res.json({ message: 'User created successfully', uid: userRecord.uid });

  } catch (err) {
    console.error("Create User Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ... (Keep markAttendance, chat, submitApplication, deleteUsers routes exactly as they were) ...
// (I'm hiding them here to keep the code block short, but do not delete them!)

app.post('/markAttendance', async (req, res) => { /* ... keep existing code ... */ });
app.post('/chat', async (req, res) => { /* ... keep existing code ... */ });
app.post('/submitApplication', async (req, res) => { /* ... keep existing code ... */ });
app.post('/deleteUsers', async (req, res) => { /* ... keep existing code ... */ });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
