import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import AdminVerification from './pages/AdminVerification';

// Mock auth for now
const isAuthenticated = true;
const userRole = 'ADMIN';

const ProtectedRoute = ({ children, requiredRole }) => {
  if (!isAuthenticated) return <Navigate to="/login" />;
  if (requiredRole && userRole !== requiredRole) return <Navigate to="/dashboard" />;
  return children;
};

// Placeholder components
const Dashboard = () => <div className="p-8 text-white">Dashboard (Redirected from Admin)</div>;
const Login = () => <div className="p-8 text-white">Login Page</div>;

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route 
          path="/admin/verification" 
          element={
            <ProtectedRoute requiredRole="ADMIN">
              <AdminVerification />
            </ProtectedRoute>
          } 
        />
        <Route path="/" element={<Navigate to="/admin/verification" />} />
      </Routes>
    </Router>
  );
}

export default App;
