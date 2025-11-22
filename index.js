const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config(); 

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// --- CONFIG: GOOGLE GEMINI AI (NOT USED BUT KEPT FOR REF) ---
// We use Groq via REST API now, but keeping this config block doesn't hurt.
// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- CONFIG: FIREBASE ADMIN ---
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
const ACCEPTABLE_RADIUS_METERS = Number(process.env.ACCEPTABLE_RADIUS_METERS || 200);

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

// --- BADGE ENGINE LOGIC ---
const BADGE_RULES = [
    { id: 'novice', threshold: 100 },
    { id: 'enthusiast', threshold: 500 },
    { id: 'expert', threshold: 1000 },
    { id: 'master', threshold: 2000 }
];

async function checkAndAwardBadges(userRef, currentXp, currentBadges = []) {
    let newBadges = [];
    BADGE_RULES.forEach(badge => {
        if (currentXp >= badge.threshold && !currentBadges.includes(badge.id)) {
            newBadges.push(badge.id);
        }
    });
    if (newBadges.length > 0) {
        await userRef.update({ badges: admin.firestore.FieldValue.arrayUnion(...newBadges) });
        return newBadges; 
    }
    return [];
}

// =======================
//        ROUTES
// =======================

app.get('/health', (req, res) => res.json({ status: 'ok', demoMode: DEMO_MODE }));

// Route 1: Create User (Database Only)
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
      subject: subject || null,
      rollNo: rollNo || null,
      qualification: qualification || null,
      xp: 0, badges: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      ...extras
    };

    await admin.firestore().collection('users').doc(userRecord.uid).set(userDoc);
    await admin.auth().setCustomUserClaims(userRecord.uid, { role, instituteId });

    return res.json({ message: 'User created successfully', uid: userRecord.uid });

  } catch (err) {
    console.error("Create User Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Route 2: Mark Attendance (+10 XP)
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
    
    if (!DEMO_MODE) {
        if (!session.location || !studentLocation) return res.status(400).json({ error: 'Location data missing' });
        const dist = getDistance(session.location.latitude, session.location.longitude, studentLocation.latitude, studentLocation.longitude);
        if (dist > ACCEPTABLE_RADIUS_METERS) return res.status(403).json({ error: `Too far! You are ${Math.round(dist)}m away.` });
    }

    const userRef = admin.firestore().collection('users').doc(studentUid);
    const userSnap = await userRef.get();

    const attRef = admin.firestore().collection('attendance').doc(`${realSessionId}_${studentUid}`);
    if ((await attRef.get()).exists) return res.json({ message: 'Already marked!' });

    await attRef.set({
      sessionId: realSessionId, subject: sessionSnap.data().subject, studentId: studentUid, 
      firstName: userSnap.data().firstName, lastName: userSnap.data().lastName, rollNo: userSnap.data().rollNo, 
      timestamp: admin.firestore.FieldValue.serverTimestamp(), status: 'Present'
    });

    // Award XP
    const newXp = (userSnap.data().xp || 0) + 10;
    await userRef.update({ xp: newXp });
    await checkAndAwardBadges(userRef, newXp, userSnap.data().badges);

    return res.json({ message: 'Attendance Marked! +10 XP' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// Route 3: AI Chatbot (GROQ API)
app.post('/chat', async (req, res) => {
    try {
        const { message, userContext } = req.body;
        const apiKey = process.env.GROQ_API_KEY;

        if (!apiKey) {
            console.error("GROQ_API_KEY is missing");
            return res.status(500).json({ reply: "Server Error: API Key missing." });
        }

        const systemPrompt = `
            You are 'AcadeX Mentor', for ${userContext.firstName}.
            Dept: ${userContext.department}.
            Suggest 3 short tasks (15-30 mins).
            Student says: "${message}". Keep response under 50 words. Be motivating.
        `;

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: message }],
                model: "llama-3.3-70b-versatile"
            })
        });

        const data = await response.json();
        if (data.error) return res.status(500).json({ reply: "AI Error: " + data.error.message });

        const text = data.choices?.[0]?.message?.content || "No response.";
        res.json({ reply: text });

    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ reply: "Brain buffering..." });
    }
});

// Route 4: Submit Institute Application
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
    await admin.firestore().collection('departments').doc(deptId).delete();
    return res.json({ message: 'Deleted.' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// Route 7: Generate Roadmap
app.post('/generateRoadmap', async (req, res) => {
    try {
        const { goal, department } = req.body;
        const apiKey = process.env.GROQ_API_KEY;
        const systemPrompt = `Create 4-Week Roadmap for ${department} student to become "${goal}". Output JSON: { "weeks": [{ "week": 1, "theme": "...", "topics": ["..."] }] }`;
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "system", content: systemPrompt }], model: "llama-3.3-70b-versatile", response_format: { type: "json_object" } })
        });
        const data = await response.json();
        const roadmapJSON = JSON.parse(data.choices[0].message.content);
        res.json({ roadmap: roadmapJSON });
    } catch (error) { res.status(500).json({ error: "Failed" }); }
});

// Route 8: Complete Task (+50 XP)
app.post('/completeTask', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID missing' });

    const userRef = admin.firestore().collection('users').doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.data();

    const now = admin.firestore.Timestamp.now();
    const lastTime = userData.lastTaskTime;
    if (lastTime && (now.toMillis() - lastTime.toMillis()) / (1000 * 60) < 15) {
        return res.status(429).json({ error: `Wait a few minutes before claiming more XP!` });
    }

    const newXp = (userData.xp || 0) + 50;
    await userRef.update({ xp: newXp, lastTaskTime: now });
    const newBadges = await checkAndAwardBadges(userRef, newXp, userData.badges);

    return res.json({ message: 'Task Verified! +50 XP', newBadges });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ✅ Route 9: Submit Student Registration Request (NEW)
app.post('/submitStudentRequest', async (req, res) => {
    try {
        const { firstName, lastName, email, rollNo, department, year, semester, collegeId, password, instituteId, instituteName } = req.body;

        if (!instituteId || !email || !rollNo || !collegeId) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const usersRef = admin.firestore().collection('users');
        const requestsRef = admin.firestore().collection('student_requests');

        // 1. Check COLLEGE ID Duplicates (Institute Level)
        const colIdCheck1 = await usersRef.where('instituteId', '==', instituteId).where('collegeId', '==', collegeId).get();
        if (!colIdCheck1.empty) return res.status(400).json({ error: `College ID "${collegeId}" is already registered.` });

        const colIdCheck2 = await requestsRef.where('instituteId', '==', instituteId).where('collegeId', '==', collegeId).get();
        if (!colIdCheck2.empty) return res.status(400).json({ error: `Application with College ID "${collegeId}" is already pending.` });

        // 2. Check ROLL NO Duplicates (Department Level)
        const rollCheck1 = await usersRef.where('instituteId', '==', instituteId).where('department', '==', department).where('rollNo', '==', rollNo).get();
        if (!rollCheck1.empty) return res.status(400).json({ error: `Roll No "${rollNo}" already exists in ${department}.` });

        const rollCheck2 = await requestsRef.where('instituteId', '==', instituteId).where('department', '==', department).where('rollNo', '==', rollNo).get();
        if (!rollCheck2.empty) return res.status(400).json({ error: `Roll No "${rollNo}" is already requested in ${department}.` });

        // 3. Add Request
        await requestsRef.add({
            firstName, lastName, email, rollNo, department, year, semester, collegeId, password, 
            instituteId, instituteName,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({ message: 'Application submitted successfully!' });

    } catch (err) {
        console.error("Student Req Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
