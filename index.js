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

// Helper function to calculate distance
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // metres
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Endpoint for creating users
app.post('/createUser', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, instituteId, extras } = req.body;
    const userRecord = await admin.auth().createUser({ email, password, displayName: `${firstName} ${lastName}` });
    const userProfile = { uid: userRecord.uid, email, role, instituteId, firstName, lastName, ...extras };
    await admin.firestore().collection('users').doc(userRecord.uid).set(userProfile);
    await admin.auth().setCustomUserClaims(userRecord.uid, { role, instituteId });
    res.status(200).send({ message: `Success! User ${email} was created.` });
  } catch (error) {
    console.error("Error creating new user:", error);
    res.status(500).send({ error: error.message });
  }
});

// Endpoint for marking attendance
app.post('/markAttendance', async (req, res) => {
    try {
        const { sessionId, studentLocation } = req.body;
        const authToken = req.headers.authorization?.split('Bearer ')[1];
        if (!authToken) return res.status(401).send({ error: 'Unauthorized. No auth token provided.' });

        const decodedToken = await admin.auth().verifyIdToken(authToken);
        const studentUid = decodedToken.uid;

        const sessionRef = admin.firestore().collection('live_sessions').doc(sessionId);
        const sessionDoc = await sessionRef.get();
        if (!sessionDoc.exists || !sessionDoc.data().isActive) {
            return res.status(404).send({ error: 'Active session not found or has ended.' });
        }
        
        const classroomLocation = sessionDoc.data().location;
        if (!classroomLocation) return res.status(500).send({ error: 'Session was started without a location.' });

        const distance = getDistance(classroomLocation.latitude, classroomLocation.longitude, studentLocation.latitude, studentLocation.longitude);

        const ACCEPTABLE_RADIUS_METERS = 50;
        if (distance > ACCEPTABLE_RADIUS_METERS) {
            return res.status(403).send({ error: `Attendance rejected. You are ${Math.round(distance)} meters away from the classroom.` });
        }
        
        const userDoc = await admin.firestore().collection('users').doc(studentUid).get();
        if (!userDoc.exists) return res.status(404).send({ error: 'Student profile not found.' });
        
        const studentData = userDoc.data();
        const attendanceRef = admin.firestore().collection('attendance').doc(`${sessionId}_${studentUid}`);
        await attendanceRef.set({
            sessionId, studentId: studentUid, studentEmail: studentData.email, firstName: studentData.firstName || '', lastName: studentData.lastName || '', rollNo: studentData.rollNo || '', timestamp: admin.firestore.FieldValue.serverTimestamp(), status: 'Present'
        });

        res.status(200).send({ message: 'Attendance Marked Successfully!' });
    } catch (error) {
        console.error("Error marking attendance:", error);
        res.status(500).send({ error: 'An internal error occurred.' });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
