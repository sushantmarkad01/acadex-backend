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

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

app.post('/createUser', async (req, res) => {
  // ... (This function is unchanged)
});

app.post('/markAttendance', async (req, res) => {
    console.log("--- Received a request to /markAttendance ---");
    try {
        const { sessionId, studentLocation } = req.body;
        const authToken = req.headers.authorization?.split('Bearer ')[1];

        if (!authToken) {
            console.log("Error: No auth token provided.");
            return res.status(401).send({ error: 'Unauthorized. No auth token provided.' });
        }
        console.log("Auth token found.");

        const decodedToken = await admin.auth().verifyIdToken(authToken);
        const studentUid = decodedToken.uid;
        console.log(`Token verified for student UID: ${studentUid}`);

        const sessionRef = admin.firestore().collection('live_sessions').doc(sessionId);
        const sessionDoc = await sessionRef.get();
        if (!sessionDoc.exists || !sessionDoc.data().isActive) {
            console.log(`Error: Session ${sessionId} not found or is not active.`);
            return res.status(404).send({ error: 'Active session not found or has ended.' });
        }
        console.log(`Found active session: ${sessionId}`);
        
        const classroomLocation = sessionDoc.data().location;
        if (!classroomLocation) {
            console.log("Error: Session has no location data.");
            return res.status(500).send({ error: 'Session was started without a location.' });
        }
        console.log("Classroom Location:", classroomLocation);
        console.log("Student Location:", studentLocation);

        const distance = getDistance(
            classroomLocation.latitude, classroomLocation.longitude,
            studentLocation.latitude, studentLocation.longitude
        );
        console.log(`Calculated Distance: ${Math.round(distance)} meters`);
        
        const ACCEPTABLE_RADIUS_METERS = 200;
        if (distance > ACCEPTABLE_RADIUS_METERS) {
            console.log("Error: Student is outside the acceptable radius.");
            return res.status(403).send({ error: `Attendance rejected. You are ${Math.round(distance)} meters away from the classroom.` });
        }
        console.log("Student is within the radius. Proceeding...");
        
        const userDoc = await admin.firestore().collection('users').doc(studentUid).get();
        if (!userDoc.exists) {
            console.log(`Error: Student profile not found for UID: ${studentUid}`);
            return res.status(404).send({ error: 'Student profile not found.' });
        }
        console.log("Found student profile.");
        
        const studentData = userDoc.data();
        const attendanceRef = admin.firestore().collection('attendance').doc(`${sessionId}_${studentUid}`);
        
        console.log("Attempting to write to Firestore attendance collection...");
        await attendanceRef.set({
            sessionId, studentId: studentUid, studentEmail: studentData.email, firstName: studentData.firstName || '', lastName: studentData.lastName || '', rollNo: studentData.rollNo || '', timestamp: admin.firestore.FieldValue.serverTimestamp(), status: 'Present'
        });
        console.log("Successfully wrote attendance to Firestore!");

        res.status(200).send({ message: 'Attendance Marked Successfully!' });
    } catch (error) {
        console.error("--- UNCAUGHT ERROR in /markAttendance ---:", error);
        res.status(500).send({ error: 'An internal error occurred.' });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
