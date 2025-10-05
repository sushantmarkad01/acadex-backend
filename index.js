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

// ... (getDistance function is unchanged) ...

// ... (createUser function is unchanged) ...

// Endpoint for marking attendance
app.post('/markAttendance', async (req, res) => {
    // ✅ --- DEMO MODE SWITCH ---
    // ✅ Set this to 'true' for your hackathon demo.
    // ✅ Set this to 'false' for real-world use.
    const DEMO_MODE = true;

    console.log("--- Received a request to /markAttendance ---");
    try {
        const { sessionId, studentLocation } = req.body;
        const authToken = req.headers.authorization?.split('Bearer ')[1];
        if (!authToken) return res.status(401).send({ error: 'Unauthorized.' });

        const decodedToken = await admin.auth().verifyIdToken(authToken);
        const studentUid = decodedToken.uid;
        console.log(`Token verified for student UID: ${studentUid}`);

        const sessionRef = admin.firestore().collection('live_sessions').doc(sessionId);
        const sessionDoc = await sessionRef.get();
        if (!sessionDoc.exists || !sessionDoc.data().isActive) {
            return res.status(404).send({ error: 'Active session not found.' });
        }
        console.log(`Found active session: ${sessionId}`);
        
        // --- Location Check Logic ---
        if (!DEMO_MODE) {
            console.log("DEMO MODE IS OFF. Performing real location check...");
            const classroomLocation = sessionDoc.data().location;
            if (!classroomLocation) return res.status(500).send({ error: 'Session has no location data.' });

            console.log("Classroom Location:", classroomLocation);
            console.log("Student Location:", studentLocation);

            const distance = getDistance(classroomLocation.latitude, classroomLocation.longitude, studentLocation.latitude, studentLocation.longitude);
            console.log(`Calculated Distance: ${Math.round(distance)} meters`);
            
            const ACCEPTABLE_RADIUS_METERS = 200;
            if (distance > ACCEPTABLE_RADIUS_METERS) {
                console.log("Error: Student is outside the acceptable radius.");
                return res.status(403).send({ error: `Attendance rejected. You are ${Math.round(distance)}m away.` });
            }
        } else {
            console.log("--- DEMO MODE IS ON: Skipping location check. ---");
        }
        
        console.log("Validation passed. Proceeding to mark attendance...");
        
        const userDoc = await admin.firestore().collection('users').doc(studentUid).get();
        if (!userDoc.exists) return res.status(404).send({ error: 'Student profile not found.' });
        
        const studentData = userDoc.data();
        const attendanceRef = admin.firestore().collection('attendance').doc(`${sessionId}_${studentUid}`);
        
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
