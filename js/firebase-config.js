// js/firebase-config.js
const firebaseConfig = {
  apiKey: "AIzaSyCwD7kax2mgcnByPVNXnqBAsa70VT3fcKk",
  authDomain: "de-rhymes-loyalty.firebaseapp.com",
  projectId: "de-rhymes-loyalty",
  storageBucket: "de-rhymes-loyalty.firebasestorage.app",
  messagingSenderId: "1:154185596808:web:4c0c4b0233428d7a81843d",
  appId: "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();