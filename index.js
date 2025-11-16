// index.js
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ---------- Firebase Admin init (from env var) ----------
function initFirebaseAdmin() {
  // Try env var first
  const svcEnv = process.env.FIREBASE_SERVICE_ACCOUNT; // expected base64 or JSON string
  if (svcEnv) {
    let svcJson;
    try {
      // If it's base64 encoded, decode
      if (/^[A-Za-z0-9+/=]+\s*$/.test(svcEnv) && svcEnv.length > 1000) {
        const decoded = Buffer.from(svcEnv, 'base64').toString('utf8');
        svcJson = JSON.parse(decoded);
      } else {
        svcJson = JSON.parse(svcEnv);
      }
    } catch (err) {
      console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT env var:", err);
      process.exit(1);
    }
    admin.initializeApp({
      credential: admin.credential.cert(svcJson),
    });
    console.log("Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT env var.");
    return;
  }

  // Local fallback (only for dev) — WARNING: do not use in production
  try {
    // eslint-disable-next-line global-require
    const local = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(local),
    });
    console.log("Firebase Admin initialized from local serviceAccountKey.json (dev only).");
    return;
  } catch (err) {
    console.error("No Firebase service account configured. Set FIREBASE_SERVICE_ACCOUNT env var.");
    process.exit(1);
  }
}
initFirebaseAdmin();

// ---------- Utility: haversine distance (meters) ----------
function getDistance(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000; // meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ---------- Config ----------
const DEMO_MODE = (process.env.DEMO_MODE || 'true') === 'true'; // Set to 'false' for real validation
const ACCEPTABLE_RADIUS_METERS = Number(process.env.ACCEPTABLE_RADIUS_METERS || 200);

// ---------- Health endpoint ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), demoMode: DEMO_MODE });
});

// ---------- Create user (secure, used by admin dashboards) ----------
/**
 * Expected body:
 * { email, password, firstName, lastName, role, instituteId, extras }
 *
 * This endpoint uses Firebase Admin to create an Auth user and a Firestore `users/{uid}` doc.
 */
app.post('/createUser', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role = 'student', instituteId = null, extras = {} } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    // Create auth user
    const userRecord = await admin.auth().createUser({ email, password, displayName: `${firstName || ''} ${lastName || ''}`.trim() });
    const uid = userRecord.uid;

    // Compose userDoc
    const userDoc = {
      uid,
      email,
      role,
      firstName: firstName || '',
      lastName: lastName || '',
      instituteId: instituteId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      ...extras
    };

    await admin.firestore().collection('users').doc(uid).set(userDoc);

    return res.json({ message: 'User created', uid });
  } catch (err) {
    console.error("/createUser error:", err);
    // If user already exists, return informative message
    if (err.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ---------- Mark attendance ----------
/**
 * Expects:
 * headers: Authorization: Bearer <idToken>
 * body: { sessionId: string, studentLocation: { latitude, longitude } }
 */
app.post('/markAttendance', async (req, res) => {
  console.log("Received /markAttendance request");
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;
    if (!token) return res.status(401).json({ error: 'Missing authorization token' });

    const decoded = await admin.auth().verifyIdToken(token);
    const studentUid = decoded.uid;

    const { sessionId, studentLocation } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const sessionRef = admin.firestore().collection('live_sessions').doc(sessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) return res.status(404).json({ error: 'Session not found' });

    const session = sessionSnap.data();
    if (!session.isActive) return res.status(400).json({ error: 'Session is not active' });

    // Validate student profile and institute membership
    const userSnap = await admin.firestore().collection('users').doc(studentUid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'Student profile not found' });
    const studentProfile = userSnap.data();

    // Ensure same institute
    if (session.instituteId && studentProfile.instituteId && session.instituteId !== studentProfile.instituteId) {
      return res.status(403).json({ error: 'Session does not belong to your institute' });
    }

    // Location check (skip if DEMO_MODE=true)
    if (!DEMO_MODE) {
      if (!session.location || !session.location.latitude || !session.location.longitude) {
        return res.status(500).json({ error: 'Session has no classroom location recorded' });
      }
      if (!studentLocation || typeof studentLocation.latitude !== 'number' || typeof studentLocation.longitude !== 'number') {
        return res.status(400).json({ error: 'studentLocation (lat/lng) required' });
      }

      const distance = getDistance(session.location.latitude, session.location.longitude, studentLocation.latitude, studentLocation.longitude);
      console.log(`Distance (m): ${distance}`);
      if (distance > ACCEPTABLE_RADIUS_METERS) {
        return res.status(403).json({ error: `Attendance rejected. You are ${Math.round(distance)}m away.` });
      }
    } else {
      console.log("DEMO_MODE enabled: skipping distance check.");
    }

    // Mark attendance (idempotent): doc id = sessionId_studentUid
    const attendanceId = `${sessionId}_${studentUid}`;
    const attendanceRef = admin.firestore().collection('attendance').doc(attendanceId);

    await attendanceRef.set({
      sessionId,
      studentId: studentUid,
      studentEmail: studentProfile.email || null,
      firstName: studentProfile.firstName || '',
      lastName: studentProfile.lastName || '',
      rollNo: studentProfile.rollNo || '',
      instituteId: studentProfile.instituteId || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'Present',
      studentLocation: studentLocation || null,
      verifiedByServer: !DEMO_MODE
    }, { merge: true });

    console.log(`Attendance saved for ${studentUid} in session ${sessionId}`);
    return res.json({ message: 'Attendance marked successfully' });
  } catch (err) {
    console.error("Error in /markAttendance:", err);
    if (err.code === 'auth/argument-error' || err.code === 'auth/id-token-expired' || err.code === 'auth/invalid-user-token') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- Start server ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Acadex backend running on port ${PORT}`);
});
