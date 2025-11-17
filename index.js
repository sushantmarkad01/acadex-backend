// ... inside your /markAttendance endpoint

        const userDoc = await admin.firestore().collection('users').doc(studentUid).get();
        if (!userDoc.exists) return res.status(404).send({ error: 'Student profile not found.' });
        
        const studentData = userDoc.data();
        const attendanceRef = admin.firestore().collection('attendance').doc(`${sessionId}_${studentUid}`);
        
        console.log("Attempting to write to Firestore attendance collection...");
        await attendanceRef.set({
            sessionId,
            // ✅ ADD THIS LINE:
            subject: sessionDoc.data().subject, // This saves the subject name!
            //
            studentId: studentUid,
            studentEmail: studentData.email,
            firstName: studentData.firstName || '',
            lastName: studentData.lastName || '',
            rollNo: studentData.rollNo || '',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            status: 'Present'
        });
        console.log("Successfully wrote attendance to Firestore!");
// ...
