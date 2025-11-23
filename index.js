const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config(); 

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

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

// --- BADGE LOGIC ---
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

// 1. Create User
app.post('/createUser', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, instituteId, instituteName, department, subject, rollNo, qualification, extras = {} } = req.body;
    const userRecord = await admin.auth().createUser({ email, password, displayName: `${firstName} ${lastName}` });
    const userDoc = { 
        uid: userRecord.uid, email, role, firstName, lastName, instituteId, instituteName, 
        department: department || null, subject: subject || null, rollNo: rollNo || null, qualification: qualification || null,
        xp: 0, badges: [], 
        createdAt: admin.firestore.FieldValue.serverTimestamp(), ...extras 
    };
    await admin.firestore().collection('users').doc(userRecord.uid).set(userDoc);
    await admin.auth().setCustomUserClaims(userRecord.uid, { role, instituteId });
    return res.json({ message: 'User created successfully', uid: userRecord.uid });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 2. Mark Attendance
app.post('/markAttendance', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const decoded = await admin.auth().verifyIdToken(token);
    const studentUid = decoded.uid;
    const { sessionId, studentLocation } = req.body;
    const [realSessionId, timestamp] = sessionId.split('|');
    
    const sessionRef = admin.firestore().collection('live_sessions').doc(realSessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists || !sessionSnap.data().isActive) return res.status(404).json({ error: 'Session not active' });

    if (!DEMO_MODE) {
        const dist = getDistance(sessionSnap.data().location.latitude, sessionSnap.data().location.longitude, studentLocation.latitude, studentLocation.longitude);
        if (dist > ACCEPTABLE_RADIUS_METERS) return res.status(403).json({ error: `Too far!` });
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

    const newXp = (userSnap.data().xp || 0) + 10;
    await userRef.update({ xp: newXp });
    await checkAndAwardBadges(userRef, newXp, userSnap.data().badges);

    return res.json({ message: 'Attendance Marked! +10 XP' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ✅ 3. AI Chatbot (The "Super Mentor")
app.post('/chat', async (req, res) => {
    try {
        const { message, userContext } = req.body;
        const apiKey = process.env.GROQ_API_KEY;

        if (!apiKey) return res.status(500).json({ reply: "Server Error: API Key missing." });

        // 🔥 SUPER SMART SYSTEM PROMPT
        const systemPrompt = `
            You are 'AcadeX Coach', a personal mentor for ${userContext.firstName}.
            Profile: ${userContext.department} student. Goal: ${userContext.careerGoal}.
            
            Your Intelligence:
            1. If the user asks for a "Quiz" or "Test", generate 3 MCQs.
            2. If the user asks for "Notes" or "Explain", provide a structured summary.
            3. If the user says "Go" or "Start", give them a "Micro-Mission".
            
            FORMATTING RULES:
            - Use Markdown (**bold**, *italic*).
            - For Resources, provide clickable URLs: https://www.youtube.com/results?search_query=TOPIC
            - Keep it friendly and motivating.
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

        res.json({ reply: data.choices?.[0]?.message?.content || "No response." });

    } catch (error) {
        res.status(500).json({ reply: "Brain buffering..." });
    }
});

// ✅ 4. Generate Notes Route (NEW)
app.post('/generateNotes', async (req, res) => {
  try {
    const { topic, department, level } = req.body;
    const apiKey = process.env.GROQ_API_KEY;
    
    const systemPrompt = `Create structured study notes for a ${department} student on: ${topic}. Level: ${level}. Use Markdown. Include: Summary, Key Points, Example.`;
    
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: systemPrompt }], model: "llama-3.3-70b-versatile" })
    });
    const data = await response.json();
    res.json({ notes: data.choices?.[0]?.message?.content || "Failed." });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// ✅ 5. Generate MCQs Route (NEW)
app.post('/generateMCQs', async (req, res) => {
  try {
    const { topic, count, department } = req.body;
    const apiKey = process.env.GROQ_API_KEY;

    const systemPrompt = `Create ${count} MCQs on "${topic}" for ${department} students. Output strict JSON format: { "mcqs": [{ "q": "...", "options": ["A", "B", "C", "D"], "answerIndex": 0, "explanation": "..." }] }`;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: systemPrompt }], model: "llama-3.3-70b-versatile", response_format: { type: "json_object" } })
    });
    const data = await response.json();
    const json = JSON.parse(data.choices[0].message.content);
    res.json(json);
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// 6. Complete Task
app.post('/completeTask', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID missing' });
    const userRef = admin.firestore().collection('users').doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.data();
    const now = admin.firestore.Timestamp.now();
    const lastTime = userData.lastTaskTime;
    if (lastTime && (now.toMillis() - lastTime.toMillis()) / (1000 * 60) < 15) return res.status(429).json({ error: `Wait a few minutes!` });
    const newXp = (userData.xp || 0) + 50;
    await userRef.update({ xp: newXp, lastTaskTime: now });
    const newBadges = await checkAndAwardBadges(userRef, newXp, userData.badges);
    return res.json({ message: 'Task Verified! +50 XP', newBadges });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 7. Generate Roadmap
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

// 8. Submit Application
app.post('/submitApplication', async (req, res) => {
  try {
    const { instituteName, contactName, email, phone, message } = req.body;
    await admin.firestore().collection('applications').add({ instituteName, contactName, email, phone, message, status: 'pending', submittedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ message: 'Success' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 9. Delete Users
app.post('/deleteUsers', async (req, res) => {
  try {
    const { userIds } = req.body;
    try { await admin.auth().deleteUsers(userIds); } catch (authErr) { console.error(authErr); }
    const batch = admin.firestore().batch();
    userIds.forEach((uid) => { batch.delete(admin.firestore().collection('users').doc(uid)); });
    await batch.commit();
    return res.json({ message: `Deleted ${userIds.length} users.` });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 10. Delete Department
app.post('/deleteDepartment', async (req, res) => {
  try {
    const { deptId } = req.body;
    await admin.firestore().collection('departments').doc(deptId).delete();
    return res.json({ message: 'Deleted.' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 11. Submit Student Request
app.post('/submitStudentRequest', async (req, res) => {
    try {
        const { firstName, lastName, email, rollNo, department, year, semester, collegeId, password, instituteId, instituteName } = req.body;
        if (!instituteId || !email || !rollNo || !collegeId) return res.status(400).json({ error: "Missing fields" });

        const usersRef = admin.firestore().collection('users');
        const requestsRef = admin.firestore().collection('student_requests');

        // Check Duplicates
        const colIdCheck1 = await usersRef.where('instituteId', '==', instituteId).where('collegeId', '==', collegeId).get();
        if (!colIdCheck1.empty) return res.status(400).json({ error: `College ID "${collegeId}" is already registered.` });
        const colIdCheck2 = await requestsRef.where('instituteId', '==', instituteId).where('collegeId', '==', collegeId).get();
        if (!colIdCheck2.empty) return res.status(400).json({ error: `Application with College ID "${collegeId}" is already pending.` });

        const rollCheck1 = await usersRef.where('instituteId', '==', instituteId).where('department', '==', department).where('rollNo', '==', rollNo).get();
        if (!rollCheck1.empty) return res.status(400).json({ error: `Roll No "${rollNo}" already exists in ${department}.` });
        const rollCheck2 = await requestsRef.where('instituteId', '==', instituteId).where('department', '==', department).where('rollNo', '==', rollNo).get();
        if (!rollCheck2.empty) return res.status(400).json({ error: `Roll No "${rollNo}" is already requested in ${department}.` });

        await requestsRef.add({ firstName, lastName, email, rollNo, department, year, semester, collegeId, password, instituteId, instituteName, status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp() });
        return res.json({ message: 'Success' });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 12. Request Leave (NEW)
app.post('/requestLeave', async (req, res) => {
  try {
    const { uid, name, rollNo, department, reason, fromDate, toDate, instituteId } = req.body;
    if (!uid || !reason || !fromDate) return res.status(400).json({ error: "Missing fields" });

    await admin.firestore().collection('leave_requests').add({
      studentId: uid, studentName: name, rollNo, department, reason, fromDate, toDate, instituteId,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.json({ message: 'Leave request sent to HOD.' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 13. Action Leave (Approve/Reject) (NEW)
app.post('/actionLeave', async (req, res) => {
  try {
    const { leaveId, status } = req.body; // status: 'approved' | 'rejected'
    await admin.firestore().collection('leave_requests').doc(leaveId).update({ status });
    return res.json({ message: `Leave request ${status}.` });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 12. End Session & Update Stats (NEW)
app.post('/endSession', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const sessionRef = admin.firestore().collection('live_sessions').doc(sessionId);
    const sessionSnap = await sessionRef.get();

    if (!sessionSnap.exists) return res.status(404).json({ error: "Session not found" });
    
    // Only increment if it was active
    if (sessionSnap.data().isActive) {
        await sessionRef.update({ isActive: false });
        
        const { instituteId, department } = sessionSnap.data();
        if (instituteId && department) {
            const statsRef = admin.firestore().collection('department_stats').doc(`${instituteId}_${department}`);
            await statsRef.set({
                totalClasses: admin.firestore.FieldValue.increment(1),
                instituteId,
                department
            }, { merge: true });
        }
    }

    return res.json({ message: "Session Ended." });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
