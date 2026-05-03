import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import AdminVerification from './pages/AdminVerification';
import LandingPage from './pages/LandingPage';
import VerificationPortal from './pages/VerificationPortal';
import CaseReview from './pages/CaseReview';
import { adminLogin } from './api';

const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem('admin_token');
  if (!token) return <Navigate to="/login" />;
  return children;
};

const Dashboard = () => <Navigate to="/admin/verification" />;

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await adminLogin(email, password);
      localStorage.setItem('admin_token', res.data.access_token);
      localStorage.setItem('admin_role', res.data.role);
      navigate('/admin/verification');
    } catch (err) {
      setError(err.response?.data?.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center p-4">
      <div className="glass-card w-full max-w-md p-8">
        <h1 className="text-2xl font-bold text-white mb-6 text-center">TrustMed Admin</h1>
        {error && <div className="bg-red-900/30 text-red-400 p-3 rounded mb-4 text-sm">{error}</div>}
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Email</label>
            <input 
              type="email" 
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-white focus:outline-none focus:border-emerald-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Password</label>
            <input 
              type="password" 
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-white focus:outline-none focus:border-emerald-500"
              required
            />
          </div>
          <button 
            type="submit" 
            disabled={loading}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2 rounded-md transition-colors disabled:opacity-50 mt-4"
          >
            {loading ? 'Logging in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/verify" element={<VerificationPortal />} />
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
        
        {/* Admin Routes */}
        <Route 
          path="/admin/verification" 
          element={
            <ProtectedRoute>
              <AdminVerification />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/admin/case/:id" 
          element={
            <ProtectedRoute>
              <CaseReview />
            </ProtectedRoute>
          } 
        />
      </Routes>
    </Router>
  );
}

export default App;
