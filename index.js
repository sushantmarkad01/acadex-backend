const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config(); 

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// --- INITIALIZE FIREBASE ADMIN ---
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
    } catch (err) {
      console.error("Failed to parse env var:", err);
      process.exit(1);
    }
  }
  try {
    const local = require('./serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(local) });
    console.log("Firebase Admin initialized from local file.");
  } catch (err) {
    console.error("No service account configured.");
    process.exit(1);
  }
}
initFirebaseAdmin();

const DEMO_MODE = (process.env.DEMO_MODE || 'true') === 'true';

// --- ROUTES ---

app.get('/health', (req, res) => res.json({ status: 'ok', demoMode: DEMO_MODE }));

// 1. Create User
app.post('/createUser', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, instituteId, instituteName, department, extras = {} } = req.body;
    const userRecord = await admin.auth().createUser({ email, password, displayName: `${firstName} ${lastName}` });
    const userDoc = { uid: userRecord.uid, email, role, firstName, lastName, instituteId, instituteName, department: department || null, createdAt: admin.firestore.FieldValue.serverTimestamp(), ...extras };
    await admin.firestore().collection('users').doc(userRecord.uid).set(userDoc);
    await admin.auth().setCustomUserClaims(userRecord.uid, { role, instituteId });
    return res.json({ message: 'User created successfully', uid: userRecord.uid });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 2. Mark Attendance
app.post('/markAttendance', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const decoded = await admin.auth().verifyIdToken(token);
    const studentUid = decoded.uid;
    const { sessionId } = req.body;
    
    const [realSessionId] = sessionId.split('|');
    if (!realSessionId) return res.status(400).json({ error: 'Invalid QR Code' });

    const sessionRef = admin.firestore().collection('live_sessions').doc(realSessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists || !sessionSnap.data().isActive) return res.status(404).json({ error: 'Session not active' });

    const userDoc = await admin.firestore().collection('users').doc(studentUid).get();
    const studentData = userDoc.data();

    await admin.firestore().collection('attendance').doc(`${realSessionId}_${studentUid}`).set({
      sessionId: realSessionId,
      subject: sessionSnap.data().subject || 'Class',
      studentId: studentUid,
      studentEmail: studentData.email,
      firstName: studentData.firstName,
      lastName: studentData.lastName,
      rollNo: studentData.rollNo,
      instituteId: studentData.instituteId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'Present'
    });
    return res.json({ message: 'Attendance Marked Successfully!' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 3. AI Chatbot Route (Using Gemini Pro)
app.post('/chat', async (req, res) => {
    try {
        const { message, userContext } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            console.error("GEMINI_API_KEY is missing");
            return res.status(500).json({ reply: "Server Error: API Key missing." });
        }

        const systemPrompt = `
            You are 'AcadeX Mentor', for ${userContext.firstName}.
            Dept: ${userContext.department}.
            Suggest 3 short tasks (15-30 mins).
            Student says: "${message}". Keep it under 50 words.
        `;

        // ✅ SWITCHED TO 'gemini-pro' (More stable availability)
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: systemPrompt + "\n\nStudent: " + message }]
                }]
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error("Google API Error:", JSON.stringify(data.error, null, 2));
            return res.status(500).json({ reply: "AI Error: " + data.error.message });
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
        res.json({ reply: text });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ reply: "My brain is buffering... (Server Error)" });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
