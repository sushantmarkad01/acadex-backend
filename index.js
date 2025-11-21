const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config(); 
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// --- 1. CONFIG: GOOGLE GEMINI AI ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- 2. CONFIG: FIREBASE ADMIN ---
function initFirebaseAdmin() {
  const svcEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svcEnv) {
    try {
      const svcJson = (/^[A-Za-z0-9+/=]+\s*$/.test(svcEnv) && svcEnv.length > 1000)
        ? JSON.parse(Buffer.from(svcEnv, 'base64').toString('utf8'))
        : JSON.parse(svcEnv);
      admin.initializeApp({ credential: admin.credential.cert(svcJson) });
      console.log("Firebase Admin initialized.");
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

// --- UTILITIES ---
function getDistance(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000; 
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// =======================
//        ROUTES
// =======================

app.get('/health', (req, res) => res.json({ status: 'ok', demoMode: DEMO_MODE }));

// Route 1: Create User (Database Only - No Email)
app.post('/createUser', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, instituteId, instituteName, department, subject, rollNo, qualification, extras = {} } = req.body;
    
    // 1. Create User in Firebase Auth
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`
    });

    // 2. Create User Doc in Firestore
    const userDoc = {
      uid: userRecord.uid,
      email,
      role, 
      firstName,
      lastName,
      instituteId,
      instituteName,
      department: department || null,
      subject: subject || null,
      rollNo: rollNo || null,
      qualification: qualification || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      ...extras
    };

    await admin.firestore().collection('users').doc(userRecord.uid).set(userDoc);
    await admin.auth().setCustomUserClaims(userRecord.uid, { role, instituteId });

    // ✅ Success! We return immediately. 
    // The Frontend (React) will send the password reset email using Firebase SDK.
    return res.json({ message: 'User created successfully', uid: userRecord.uid });

  } catch (err) {
    console.error("Create User Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Route 2: Mark Attendance
app.post('/markAttendance', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const decoded = await admin.auth().verifyIdToken(token);
    const studentUid = decoded.uid;
    const { sessionId, studentLocation } = req.body;

    const [realSessionId, timestamp] = sessionId.split('|');
    if (!realSessionId) return res.status(400).json({ error: 'Invalid QR Code' });

    if (timestamp) {
        const qrTime = parseInt(timestamp);
        const timeDiff = (Date.now() - qrTime) / 1000;
        if (timeDiff > 15) return res.status(400).json({ error: 'QR Code Expired!' });
    }

    const sessionRef = admin.firestore().collection('live_sessions').doc(realSessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists || !sessionSnap.data().isActive) return res.status(404).json({ error: 'Session not active' });

    const session = sessionSnap.data();
    
    if (!DEMO_MODE) {
        if (!session.location || !studentLocation) return res.status(400).json({ error: 'Location data missing' });
        const dist = getDistance(session.location.latitude, session.location.longitude, studentLocation.latitude, studentLocation.longitude);
        if (dist > ACCEPTABLE_RADIUS_METERS) return res.status(403).json({ error: `Too far! You are ${Math.round(dist)}m away.` });
    }

    const userDoc = await admin.firestore().collection('users').doc(studentUid).get();
    const studentData = userDoc.data();

    await admin.firestore().collection('attendance').doc(`${realSessionId}_${studentUid}`).set({
      sessionId: realSessionId,
      subject: session.subject || 'Class',
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

// Route 3: AI Chatbot
app.post('/chat', async (req, res) => {
    try {
        const { message, userContext } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) return res.status(500).json({ reply: "Server Error: API Key missing." });

        const systemPrompt = `
            You are 'AcadeX Mentor', for ${userContext.firstName}.
            Dept: ${userContext.department}.
            Suggest 3 short tasks (15-30 mins).
            Student says: "${message}". Keep it under 50 words.
        `;

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: systemPrompt + "\n\nStudent: " + message }] }] })
        });

        const data = await response.json();
        if (data.error) return res.status(500).json({ reply: "AI Error: " + data.error.message });

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
        res.json({ reply: text });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ reply: "My brain is buffering..." });
    }
});

// Route 4: Submit Application
app.post('/submitApplication', async (req, res) => {
  try {
    const { instituteName, contactName, email, phone, message } = req.body;
    if (!instituteName || !contactName || !email) return res.status(400).json({ error: 'Missing fields' });

    await admin.firestore().collection('applications').add({
      instituteName, contactName, email, phone, message, status: 'pending', submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ message: 'Success' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// Route 5: Delete Users
app.post('/deleteUsers', async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!userIds || userIds.length === 0) return res.status(400).json({ error: 'No users selected.' });

    try { await admin.auth().deleteUsers(userIds); } catch (authErr) { console.error(authErr); }

    const batch = admin.firestore().batch();
    userIds.forEach((uid) => {
        const userRef = admin.firestore().collection('users').doc(uid);
        batch.delete(userRef);
    });
    await batch.commit();

    return res.json({ message: `Deleted ${userIds.length} users.` });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// Route 6: Delete Department
app.post('/deleteDepartment', async (req, res) => {
  try {
    const { deptId } = req.body;
    if (!deptId) return res.status(400).json({ error: 'Department ID is required' });
    await admin.firestore().collection('departments').doc(deptId).delete();
    return res.json({ message: 'Department deleted successfully.' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
