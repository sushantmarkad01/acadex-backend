const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Initialize Firebase Admin
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

// Utility: Haversine Distance
function getDistance(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000; // meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const DEMO_MODE = (process.env.DEMO_MODE || 'true') === 'true';
const ACCEPTABLE_RADIUS_METERS = Number(process.env.ACCEPTABLE_RADIUS_METERS || 200);

app.get('/health', (req, res) => res.json({ status: 'ok', demoMode: DEMO_MODE }));

// 1. Create User (Updated for HOD & Department)
app.post('/createUser', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, instituteId, instituteName, department, extras = {} } = req.body;
    
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`
    });

    const userDoc = {
      uid: userRecord.uid,
      email,
      role, // Can now be 'hod'
      firstName,
      lastName,
      instituteId,
      instituteName,
      department: department || null, // Save department for HODs
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      ...extras
    };

    await admin.firestore().collection('users').doc(userRecord.uid).set(userDoc);
    await admin.auth().setCustomUserClaims(userRecord.uid, { role, instituteId });

    // In production, send email here. For hackathon, logging link.
    const link = await admin.auth().generatePasswordResetLink(email);
    console.log(`Password reset link for ${email}: ${link}`);

    return res.json({ message: 'User created successfully', uid: userRecord.uid });
  } catch (err) {
    console.error("Error in /createUser:", err);
    return res.status(500).json({ error: err.message });
  }
});

// 2. Mark Attendance (Updated for Dynamic QR Validation)
app.post('/markAttendance', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const decoded = await admin.auth().verifyIdToken(token);
    const studentUid = decoded.uid;
    const { sessionId, studentLocation } = req.body;

    // --- DYNAMIC QR VALIDATION ---
    // The frontend now sends "realSessionId|timestamp"
    const [realSessionId, timestamp] = sessionId.split('|');
    
    if (!realSessionId) return res.status(400).json({ error: 'Invalid QR Code' });

    // If there is a timestamp, verify it (15 seconds validity window)
    if (timestamp) {
        const qrTime = parseInt(timestamp);
        const currentTime = Date.now();
        const timeDiff = (currentTime - qrTime) / 1000; // in seconds

        if (timeDiff > 15) {
            return res.status(400).json({ error: 'QR Code Expired! Please scan the new code.' });
        }
    }
    // -----------------------------

    const sessionRef = admin.firestore().collection('live_sessions').doc(realSessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists || !sessionSnap.data().isActive) {
      return res.status(404).json({ error: 'Session not active' });
    }

    const session = sessionSnap.data();
    
    // Geo-Location Check
    if (!DEMO_MODE) {
        if (!session.location || !studentLocation) return res.status(400).json({ error: 'Location data missing' });
        
        const dist = getDistance(
            session.location.latitude, session.location.longitude,
            studentLocation.latitude, studentLocation.longitude
        );
        console.log(`Distance: ${dist}m`);
        
        if (dist > ACCEPTABLE_RADIUS_METERS) {
            return res.status(403).json({ error: `Too far! You are ${Math.round(dist)}m away.` });
        }
    }

    // Mark Attendance
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
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
