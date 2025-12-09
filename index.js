const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const multer = require('multer'); 
const cloudinary = require('cloudinary').v2; 
const rateLimit = require('express-rate-limit'); 
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
// ✅ 1. IMPORT CRYPTO FOR ENCRYPTION
const crypto = require('crypto'); 

const { callGroqAI, computeHash, isUnsafe, MODEL_ID } = require('./lib/groqClient'); 

require('dotenv').config(); 

const app = express();

// ✅ 2. CORS CONFIGURATION
app.use(cors({
  origin: 'https://scheduplan-1b51d.web.app', 
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());

// ==========================================
// 🔐 ENCRYPTION HELPERS (AES-256-CBC)
// ==========================================
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; 
const IV_LENGTH = 16; 

function encrypt(text) {
    if (!text) return text;
    const textStr = String(text); // Ensure it's a string
    try {
        if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
            console.warn("⚠️ ENCRYPTION SKIPPED: Key missing or invalid length.");
            return textStr; 
        }
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let encrypted = cipher.update(textStr);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (error) {
        console.error("Encryption Error:", error);
        return textStr;
    }
}

function decrypt(text) {
    if (!text || !text.includes(':')) return text;
    try {
        if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) return text;
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        // console.error("Decryption Error:", error); 
        return text;
    }
}
// ==========================================

const taskLimiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, 
    max: 20, 
    message: { error: "Too many tasks generated. Slow down!" } 
});

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, 
  max: 60,
  message: { error: "Too many requests." }
});
app.use(limiter);

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 10,
  message: { error: "Limit reached." }
});

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } 
});

cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET 
});

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

// ✅ LOAD ROUTES AFTER FIREBASE INIT
const passkeyRoutes = require('./passkeyRoutes');
app.use('/auth/passkeys', passkeyRoutes);

// --- UTILITIES ---
const DEMO_MODE = (process.env.DEMO_MODE || 'true') === 'true';
const ACCEPTABLE_RADIUS_METERS = Number(process.env.ACCEPTABLE_RADIUS_METERS || 200);

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

async function uploadToCloudinary(fileBuffer) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: "acadex_docs", resource_type: "auto" }, 
            (error, result) => {
                if (error) reject(error);
                else resolve(result.secure_url);
            }
        );
        stream.end(fileBuffer);
    });
}

async function deleteCollection(db, collectionPath, batchSize, queryField, queryValue) {
  const collectionRef = db.collection(collectionPath);
  const query = collectionRef.where(queryField, '==', queryValue).limit(batchSize);
  return new Promise((resolve, reject) => {
    deleteQueryBatch(db, query, resolve).catch(reject);
  });
}

async function deleteQueryBatch(db, query, resolve) {
  const snapshot = await query.get();
  if (snapshot.size === 0) { resolve(); return; }
  const batch = db.batch();
  snapshot.docs.forEach((doc) => { batch.delete(doc.ref); });
  await batch.commit();
  process.nextTick(() => { deleteQueryBatch(db, query, resolve); });
}

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

app.get('/health', (req, res) => res.json({ status: 'ok', demoMode: DEMO_MODE }));

// --- AI STUDY ROUTES (Safe to keep plain) ---
app.post('/storeTopic', async (req, res) => {
  try {
    const { userId, topic } = req.body;
    if (!userId || !topic) return res.status(400).json({ error: "Missing fields" });
    if (isUnsafe(topic)) return res.status(400).json({ error: "Unsafe topic." });
    const topicId = computeHash(topic.toLowerCase().trim());
    const userRef = admin.firestore().collection('users').doc(userId);
    await userRef.update({
      latestTopic: { topicId, topicName: topic, storedAt: admin.firestore.FieldValue.serverTimestamp() }
    });
    await userRef.collection('topics').doc(topicId).set({
      topicName: topic, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'user_input'
    }, { merge: true });
    res.json({ ok: true, topicId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/notes', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "User ID required" });
    const userSnap = await admin.firestore().collection('users').doc(userId).get();
    const latestTopic = userSnap.data()?.latestTopic;
    if (!latestTopic || !latestTopic.topicName) return res.status(400).json({ error: "No topic." });

    const topicName = latestTopic.topicName;
    const cacheKey = computeHash(`${topicName}_notes_${MODEL_ID}`);
    const noteRef = admin.firestore().collection('notes').doc(cacheKey);
    const noteSnap = await noteRef.get();

    if (noteSnap.exists) return res.json({ fromCache: true, note: noteSnap.data() });

    const systemPrompt = `Educational assistant. Concise notes.`;
    const userPrompt = `Notes for: "${topicName}". 200 words.`;
    const generatedContent = await callGroqAI(systemPrompt, userPrompt, false);

    const noteData = {
      topicName, content: generatedContent, generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      generatedForUserId: userId, prompt: userPrompt, modelVersion: MODEL_ID, hash: cacheKey
    };
    await noteRef.set(noteData);
    res.json({ fromCache: false, note: noteData });
  } catch (err) { console.error(err); res.status(500).json({ error: "Failed." }); }
});

app.get('/quiz', async (req, res) => {
  try {
    const { userId, numQuestions = 5, difficulty = 'medium' } = req.query;
    if (!userId) return res.status(400).json({ error: "User ID required" });
    const userSnap = await admin.firestore().collection('users').doc(userId).get();
    const latestTopic = userSnap.data()?.latestTopic;
    if (!latestTopic || !latestTopic.topicName) return res.status(400).json({ error: "No topic." });

    const topicName = latestTopic.topicName;
    const cacheKey = computeHash(`${topicName}_quiz_${difficulty}_${numQuestions}_${MODEL_ID}`);
    const quizRef = admin.firestore().collection('quizzes').doc(cacheKey);
    const quizSnap = await quizRef.get();

    if (quizSnap.exists) return res.json({ fromCache: true, quiz: quizSnap.data() });

    const systemPrompt = `Quiz generator. JSON only.`;
    const userPrompt = `Create ${numQuestions} MCQs for "${topicName}". JSON Format: { "quizTitle": "...", "questions": [...] }`;
    const quizJson = await callGroqAI(systemPrompt, userPrompt, true);

    const quizData = {
      topicName, difficulty, questions: quizJson.questions || [], quizTitle: quizJson.quizTitle,
      generatedAt: admin.firestore.FieldValue.serverTimestamp(), generatedForUserId: userId,
      prompt: userPrompt, modelVersion: MODEL_ID, hash: cacheKey
    };
    await quizRef.set(quizData);
    res.json({ fromCache: false, quiz: quizData });
  } catch (err) { console.error(err); res.status(500).json({ error: "Failed." }); }
});

app.post('/quizAttempt', async (req, res) => {
  try {
    const { userId, quizId, answers, score } = req.body;
    if (!userId || !quizId) return res.status(400).json({ error: "Invalid" });
    const attemptData = { quizId, score, answers: answers || [], timestamp: admin.firestore.FieldValue.serverTimestamp() };
    const docRef = await admin.firestore().collection('userProgress').doc(userId).collection('attempts').add(attemptData);
    if (score > 60) {
        const userRef = admin.firestore().collection('users').doc(userId);
        await userRef.update({ xp: admin.firestore.FieldValue.increment(20) });
    }
    res.json({ ok: true, attemptId: docRef.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =======================
//   CORE APP ROUTES (ENCRYPTED)
// =======================

// ✅ 1. CREATE USER (ENCRYPT PROFILE)
app.post('/createUser', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, instituteId, instituteName, department, subject, rollNo, qualification, extras = {} } = req.body;
    
    // Create Auth User (Plain names needed for Auth Display)
    const userRecord = await admin.auth().createUser({ email, password, displayName: `${firstName} ${lastName}` });
    
    // 🔥 ENCRYPT DATA FOR FIRESTORE
    const userDoc = { 
        uid: userRecord.uid, 
        email, // Keep plain for lookup
        role, 
        firstName: encrypt(firstName), // 🔒
        lastName: encrypt(lastName),   // 🔒
        instituteId, // Plain for routing
        instituteName: encrypt(instituteName), // 🔒
        department: encrypt(department), // 🔒
        subject: encrypt(subject),       // 🔒
        rollNo: encrypt(rollNo),         // 🔒
        qualification: encrypt(qualification), // 🔒
        xp: 0, badges: [], 
        createdAt: admin.firestore.FieldValue.serverTimestamp(), ...extras 
    };
    
    await admin.firestore().collection('users').doc(userRecord.uid).set(userDoc);
    await admin.auth().setCustomUserClaims(userRecord.uid, { role, instituteId });
    return res.json({ message: 'User created successfully', uid: userRecord.uid });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ✅ 2. MARK ATTENDANCE (INHERITS ENCRYPTION)
app.post('/markAttendance', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing token' });
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const studentUid = decoded.uid;
    const { sessionId, studentLocation } = req.body;

    const [realSessionId, timestamp] = sessionId.split('|');
    if (!realSessionId) return res.status(400).json({ error: 'Invalid QR' });
    if (timestamp && (Date.now() - parseInt(timestamp))/1000 > 15) return res.status(400).json({ error: 'QR Expired!' });

    const sessionRef = admin.firestore().collection('live_sessions').doc(realSessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists || !sessionSnap.data().isActive) return res.status(404).json({ error: 'Session not active' });
    const session = sessionSnap.data();
    
    if (!DEMO_MODE) {
        if (!session.location || !studentLocation) return res.status(400).json({ error: 'Location missing' });
        const dist = getDistance(session.location.latitude, session.location.longitude, studentLocation.latitude, studentLocation.longitude);
        if (dist > ACCEPTABLE_RADIUS_METERS) return res.status(403).json({ error: `Too far! (${Math.round(dist)}m)` });
    }

    const userRef = admin.firestore().collection('users').doc(studentUid);
    const userDoc = await userRef.get();
    const studentData = userDoc.data();

    // Data from 'users' is already encrypted, so we just copy it over.
    await admin.firestore().collection('attendance').doc(`${realSessionId}_${studentUid}`).set({
      sessionId: realSessionId, 
      subject: session.subject || 'Class', // (Subject might be encrypted in session too if set elsewhere)
      studentId: studentUid,
      studentEmail: studentData.email, 
      firstName: studentData.firstName, // 🔒 Already Encrypted
      lastName: studentData.lastName,   // 🔒 Already Encrypted
      rollNo: studentData.rollNo,       // 🔒 Already Encrypted
      instituteId: studentData.instituteId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(), status: 'Present'
    });
    await userRef.update({ attendanceCount: admin.firestore.FieldValue.increment(1) });
    return res.json({ message: 'Attendance Marked!' });
  } catch (err) { console.error(err); return res.status(500).json({ error: err.message }); }
});

app.post('/chat', async (req, res) => {
    try {
        const { message, userContext } = req.body;
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) return res.status(500).json({ reply: "API Key missing." });
        const systemPrompt = `You are 'AcadeX Coach' for ${userContext.firstName}.`;
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "system", content: systemPrompt }, { role: "user", content: message }], model: "llama-3.3-70b-versatile" })
        });
        const data = await response.json();
        res.json({ reply: data.choices?.[0]?.message?.content || "No response." });
    } catch (error) { res.status(500).json({ reply: "Brain buffering..." }); }
});

// ✅ 3. SUBMIT APPLICATION (HEAVY ENCRYPTION)
app.post('/submitApplication', upload.single('document'), async (req, res) => {
  try {
    const { instituteName, contactName, email, phone, message } = req.body;
    const file = req.file; 
    let documentUrl = null;
    if (file) {
        try { documentUrl = await uploadToCloudinary(file.buffer); } catch (e) { return res.status(500).json({ error: "Upload failed" }); }
    }

    // 🔒 ENCRYPT SENSITIVE FIELDS
    await admin.firestore().collection('applications').add({
      instituteName: encrypt(instituteName), // 🔒
      contactName: encrypt(contactName),     // 🔒
      email,                                 // 👁️ Plain
      phone: encrypt(phone),                 // 🔒
      message: encrypt(message),             // 🔒
      documentUrl: documentUrl, 
      status: 'pending',
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ message: 'Application submitted successfully!' });
  } catch (err) { console.error(err); return res.status(500).json({ error: err.message }); }
});

// ✅ 4. SUBMIT STUDENT REQUEST (HEAVY ENCRYPTION)
app.post('/submitStudentRequest', async (req, res) => {
    try {
        const { firstName, lastName, email, rollNo, department, year, semester, collegeId, password, instituteId, instituteName } = req.body;
        
        // 🔒 ENCRYPT EVERYTHING
        await admin.firestore().collection('student_requests').add({
            firstName: encrypt(firstName),   // 🔒
            lastName: encrypt(lastName),     // 🔒
            email,                           // 👁️ Plain
            rollNo: encrypt(rollNo),         // 🔒
            department: encrypt(department), // 🔒
            year: encrypt(year),             // 🔒
            semester: encrypt(semester),     // 🔒
            collegeId: encrypt(collegeId),   // 🔒
            password: encrypt(password),     // 🔒
            instituteId,                     // 👁️ Plain
            instituteName: encrypt(instituteName), // 🔒
            status: 'pending', 
            createdAt: admin.firestore.FieldValue.serverTimestamp() 
        });
        return res.json({ message: 'Success' });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ✅ 5. CHECK STATUS (DECRYPT FOR USER VIEW)
app.post('/checkStatus', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    // A. Student Requests
    const studentSnap = await admin.firestore().collection('student_requests')
      .where('email', '==', email).limit(1).get();
    if (!studentSnap.empty) {
        const data = studentSnap.docs[0].data();
        return res.json({ found: true, role: 'student', status: data.status, message: `Status: ${data.status.toUpperCase()}` });
    }

    // B. Institute Applications 
    const instituteSnap = await admin.firestore().collection('applications')
      .where('email', '==', email).limit(1).get();
    if (!instituteSnap.empty) {
        const data = instituteSnap.docs[0].data();
        return res.json({ found: true, role: 'institute', status: data.status, message: `Status: ${data.status.toUpperCase()}` });
    }

    // C. Existing Users
    const userSnap = await admin.firestore().collection('users')
      .where('email', '==', email).limit(1).get();
    if (!userSnap.empty) {
        return res.json({ found: true, status: 'approved', message: "Account active. Please Login." });
    }
    return res.json({ found: false, message: "No record found." });
  } catch (err) { console.error(err); return res.status(500).json({ error: err.message }); }
});

app.post('/deleteUsers', async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!userIds || userIds.length === 0) return res.status(400).json({ error: 'No users' });
    try { await admin.auth().deleteUsers(userIds); } catch (e) { console.error(e); }
    const batch = admin.firestore().batch();
    userIds.forEach(uid => batch.delete(admin.firestore().collection('users').doc(uid)));
    await batch.commit();
    return res.json({ message: `Deleted.` });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/deleteDepartment', async (req, res) => {
  try {
    const { deptId } = req.body;
    await admin.firestore().collection('departments').doc(deptId).delete();
    return res.json({ message: 'Deleted.' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ✅ 6. REQUEST LEAVE (ENCRYPT)
app.post('/requestLeave', upload.single('document'), async (req, res) => {
  try {
    const { uid, name, rollNo, department, reason, fromDate, toDate, instituteId } = req.body;
    const file = req.file;
    let documentUrl = null;
    if (file) { try { documentUrl = await uploadToCloudinary(file.buffer); } catch (e) { return res.status(500).json({ error: "Upload failed" }); } }
    
    await admin.firestore().collection('leave_requests').add({
      studentId: uid, 
      studentName: encrypt(name), // 🔒
      rollNo: encrypt(rollNo),    // 🔒
      department: encrypt(department), // 🔒
      reason: encrypt(reason),    // 🔒
      fromDate, toDate, instituteId,
      documentUrl, status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.json({ message: 'Request sent!' });
  } catch (err) { console.error(err); return res.status(500).json({ error: err.message }); }
});

app.post('/actionLeave', async (req, res) => {
  try {
    const { leaveId, status } = req.body; 
    await admin.firestore().collection('leave_requests').doc(leaveId).update({ status });
    return res.json({ message: `Updated.` });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/endSession', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const sessionRef = admin.firestore().collection('live_sessions').doc(sessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) return res.status(404).json({ error: "Not found" });
    if (sessionSnap.data().isActive) {
        await sessionRef.update({ isActive: false });
        const { instituteId, department } = sessionSnap.data();
        if (instituteId && department) {
            const statsRef = admin.firestore().collection('department_stats').doc(`${instituteId}_${department}`);
            await statsRef.set({ totalClasses: admin.firestore.FieldValue.increment(1), instituteId, department }, { merge: true });
        }
    }
    return res.json({ message: "Ended." });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/getAttendanceAnalytics', async (req, res) => {
    try {
        const { instituteId, subject } = req.body;
        const now = new Date();
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(now.getDate() - 7);
        const snapshot = await admin.firestore().collection('attendance')
            .where('instituteId', '==', instituteId).where('subject', '==', subject).where('timestamp', '>=', sevenDaysAgo).get();
        const counts = { 'Mon': 0, 'Tue': 0, 'Wed': 0, 'Thu': 0, 'Fri': 0, 'Sat': 0, 'Sun': 0 };
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        snapshot.forEach(doc => { counts[days[doc.data().timestamp.toDate().getDay()]]++; });
        return res.json({ chartData: Object.keys(counts).map(key => ({ name: key, present: counts[key] })) });
    } catch (err) { return res.status(500).json({ error: "Failed" }); }
});

app.post('/deleteInstitute', async (req, res) => {
  try {
    const { instituteId } = req.body;
    if (!instituteId) return res.status(400).json({ error: 'Missing ID' });
    const usersSnap = await admin.firestore().collection('users').where('instituteId', '==', instituteId).get();
    const uids = [];
    usersSnap.forEach(doc => uids.push(doc.id));
    if (uids.length > 0) {
      const chunks = [];
      for (let i = 0; i < uids.length; i += 1000) chunks.push(uids.slice(i, i + 1000));
      for (const chunk of chunks) await admin.auth().deleteUsers(chunk).catch(e => console.error(e));
    }
    const db = admin.firestore();
    await deleteCollection(db, 'users', 500, 'instituteId', instituteId);
    await deleteCollection(db, 'attendance', 500, 'instituteId', instituteId);
    await deleteCollection(db, 'announcements', 500, 'instituteId', instituteId);
    await deleteCollection(db, 'live_sessions', 500, 'instituteId', instituteId);
    await deleteCollection(db, 'student_requests', 500, 'instituteId', instituteId);
    await deleteCollection(db, 'leave_requests', 500, 'instituteId', instituteId);
    await db.collection('institutes').doc(instituteId).delete();
    await db.collection('applications').doc(instituteId).delete();
    return res.json({ message: 'Deleted.' });
  } catch (err) { console.error("Delete Error:", err); return res.status(500).json({ error: err.message }); }
});

app.post('/generateQuiz', async (req, res) => {
    try {
        const { department, semester, careerGoal } = req.body;
        const apiKey = process.env.GROQ_API_KEY;
        const systemPrompt = `Professor. 10 MCQs for ${department} student. Topic: "${careerGoal}". JSON: { "questions": [...] }`;
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "system", content: systemPrompt }], model: "llama-3.3-70b-versatile", response_format: { type: "json_object" } })
        });
        const data = await response.json();
        const cleanJson = data.choices[0].message.content.replace(/```json|```/g, '').trim();
        res.json(JSON.parse(cleanJson));
    } catch (error) { res.status(500).json({ error: "Failed" }); }
});

app.post('/updateResume', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader.split('Bearer ')[1];
        if (!token) return res.status(401).json({ error: 'Missing token' });
        const decoded = await admin.auth().verifyIdToken(token);
        const uid = decoded.uid;
        const { resumeData } = req.body; 
        if (!resumeData) return res.status(400).json({ error: "No data" });
        const userRef = admin.firestore().collection('users').doc(uid);
        await userRef.update({ resumeData: resumeData, xp: admin.firestore.FieldValue.increment(50) });
        return res.json({ message: 'Updated! +50 XP' });
    } catch (error) { return res.status(500).json({ error: error.message }); }
});

// ✅ 7. CREATE ASSIGNMENT (ENCRYPT DETAILS)
app.post('/createAssignment', async (req, res) => {
    try {
        const { teacherId, teacherName, department, targetYear, title, description, dueDate } = req.body;
        await admin.firestore().collection('assignments').add({
            teacherId, 
            teacherName: encrypt(teacherName), // 🔒
            department: encrypt(department),   // 🔒
            targetYear: encrypt(targetYear),   // 🔒
            title: encrypt(title),             // 🔒
            description: encrypt(description), // 🔒
            dueDate,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return res.json({ message: "Created!" });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/getAssignments', async (req, res) => {
    try {
        const { department, year } = req.body;
        // NOTE: Filtering by encrypted fields (department/year) is impossible directly.
        // You would need to fetch ALL and filter in memory, or store plain-text "searchable" fields alongside encrypted ones.
        // For now, returning empty or error if filtered by encrypted data.
        return res.json({ tasks: [] }); 
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ✅ 8. SUBMIT ASSIGNMENT (ENCRYPT STUDENT INFO)
app.post('/submitAssignment', upload.single('document'), async (req, res) => {
    try {
        const { studentId, studentName, rollNo, assignmentId } = req.body;
        const file = req.file;
        if (!file) return res.status(400).json({ error: "No file" });
        
        const documentUrl = await uploadToCloudinary(file.buffer);
        await admin.firestore().collection('submissions').add({
            assignmentId, studentId, 
            studentName: encrypt(studentName), // 🔒
            rollNo: encrypt(rollNo),           // 🔒
            documentUrl,
            status: 'Pending', marks: null, submittedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return res.json({ message: "Submitted!" });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/getSubmissions', async (req, res) => {
    try {
        const { assignmentId } = req.body;
        const snapshot = await admin.firestore().collection('submissions').where('assignmentId', '==', assignmentId).get();
        const submissions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        return res.json({ submissions });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/gradeSubmission', async (req, res) => {
    try {
        const { submissionId, marks, feedback } = req.body;
        await admin.firestore().collection('submissions').doc(submissionId).update({ status: 'Graded', marks, feedback: encrypt(feedback) });
        return res.json({ message: "Graded!" });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/generateDeepTask', async (req, res) => {
    try {
        const { userProfile } = req.body; 
        if (!userProfile) return res.status(400).json({ error: "Missing Profile" });
        const { domain, subDomain, specificSkills, year, department } = userProfile;
        const systemPrompt = `Academic Mentor. Output strict JSON only.`;
        const userPrompt = `Create 20-min task for ${year} year ${department} student interested in ${domain}/${subDomain}. Skill: ${specificSkills}. JSON: { "taskTitle": "...", "difficulty": "...", "estimatedTime": "...", "xpReward": 100, "skillsTargeted": [...], "instructions": [...], "deliverableType": "..." }`;
        const taskJson = await callGroqAI(systemPrompt, userPrompt, true);
        return res.json({ task: taskJson });
    } catch (err) { return res.status(500).json({ error: "Failed" }); }
});

app.post('/verifyQuickTask', verifyLimiter, async (req, res) => {
  try {
    const { uid, taskTitle, proofText, taskType, xpReward } = req.body;
    if (!uid || !taskTitle || !proofText) return res.status(400).json({ error: "Missing Data" });
    if (proofText.length < 15) return res.status(400).json({ error: "Too short." });

    const userRef = admin.firestore().collection('users').doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.data();
    const now = admin.firestore.Timestamp.now();
    
    if (userData.lastQuickTaskTime && (now.toMillis() - userData.lastQuickTaskTime.toMillis()) / (1000 * 60) < 15) return res.status(429).json({ error: `Cooldown active.` });

    const systemPrompt = `Strict teacher. Reply 'VALID' or 'INVALID' only.`;
    const userPrompt = `Task: "${taskTitle}". Proof: "${proofText}". Valid attempt?`;
    const aiVerdict = await callGroqAI(systemPrompt, userPrompt, false);

    if (aiVerdict.includes("INVALID")) return res.status(400).json({ error: "AI Rejected." });

    const points = xpReward || 30;
    await userRef.update({ xp: admin.firestore.FieldValue.increment(points), lastQuickTaskTime: now });
    const newBadges = await checkAndAwardBadges(userRef, (userData.xp || 0) + points, userData.badges);
    return res.json({ success: true, message: `Verified! +${points} XP`, newBadges });
  } catch (err) { return res.status(500).json({ error: "Failed." }); }
});

app.post('/startInteractiveTask', taskLimiter, async (req, res) => {
    try {
        const { taskType, userInterest } = req.body; 
        let prompt = taskType === 'Coding' ? `Junior Dev bug fix for ${userInterest}. JSON: {title, scenario, starterCode}` : `Scenario logic puzzle for ${userInterest}. JSON: {title, scenario, options, correctIndex}`;
        const data = await callGroqAI("Gamified Task Gen", prompt, true);
        res.json(data);
    } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.post('/submitInteractiveTask', async (req, res) => {
    try {
        const { uid, taskType, submission, context } = req.body;
        const userRef = admin.firestore().collection('users').doc(uid);
        let passed = false, credits = 0;

        if (taskType === 'Coding') {
            const aiCheck = await callGroqAI("Code Mentor", `Task: ${context.problemStatement}. Code: ${submission.code}. Valid? JSON: {passed: bool, feedback: string}`, true);
            passed = aiCheck.passed;
        } else {
            passed = (submission.answerIndex === context.correctIndex);
        }

        if (passed) {
            credits = 50;
            await userRef.update({ xp: admin.firestore.FieldValue.increment(credits) });
        }
        return res.json({ passed, credits });
    } catch (err) { res.status(500).json({ error: "Error" }); }
});

app.post('/generatePersonalizedTasks', async (req, res) => {
    try {
        const { userProfile } = req.body;
        if (!userProfile) return res.json({ tasks: [] }); 
        const prompt = `Generate 3 short tasks for ${userProfile.domain} student. JSON Array: [{id, title, type, xp, content}]`;
        const aiResponse = await callGroqAI("Curriculum", prompt, true); 
        res.json({ tasks: Array.isArray(aiResponse) ? aiResponse : [] });
    } catch (error) { res.status(500).json({ error: "Failed" }); }
});

app.post('/verifyAiTask', async (req, res) => {
    try {
        const { originalTask, userSubmission } = req.body;
        const result = await callGroqAI("Grader", `Task: ${JSON.stringify(originalTask)}. Sub: ${userSubmission}. Valid? JSON: {passed, feedback}`, true);
        res.json(result);
    } catch (error) { res.status(500).json({ error: "Failed" }); }
});

app.post('/setup2FA', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const secret = speakeasy.generateSecret({ name: `AcadeX (${decoded.email})` });
    const qrImage = await QRCode.toDataURL(secret.otpauth_url);
    await admin.firestore().collection('secrets').doc(decoded.uid).set({ tempSecret: secret.base32, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ qrImage, manualEntry: secret.base32 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/verify2FA', async (req, res) => {
  try {
    const { token: userCode, isLogin } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;
    const secretDoc = await admin.firestore().collection('secrets').doc(uid).get();
    if (!secretDoc.exists) return res.status(400).json({ error: 'Setup not started' });
    
    const secretKey = isLogin ? secretDoc.data().secret : secretDoc.data().tempSecret;
    const verified = speakeasy.totp.verify({ secret: secretKey, encoding: 'base32', token: userCode, window: 1 });

    if (verified) {
      if (!isLogin) {
        await admin.firestore().collection('secrets').doc(uid).update({ secret: secretKey, tempSecret: admin.firestore.FieldValue.delete() });
        await admin.firestore().collection('users').doc(uid).update({ is2FAEnabled: true });
      }
      res.json({ success: true });
    } else {
      res.status(400).json({ error: "Invalid Code" });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
