import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Stethoscope, Fingerprint, Lock } from 'lucide-react';

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#0a0f1e] text-slate-200 font-sans selection:bg-emerald-500/30 overflow-x-hidden">
      {/* Navbar */}
      <nav className="w-full border-b border-slate-800 bg-[#0a0f1e]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/')}>
            <ShieldCheck className="w-8 h-8 text-emerald-500" />
            <span className="text-xl font-bold text-white tracking-tight">TrustMed</span>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={() => navigate('/login')}
              className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
            >
              Admin Login
            </button>
            <button 
              onClick={() => navigate('/verify')}
              className="text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-md transition-all shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:shadow-[0_0_25px_rgba(16,185,129,0.5)]"
            >
              Verify Now
            </button>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="relative pt-32 pb-20 sm:pt-40 sm:pb-24 overflow-hidden">
        {/* Background glow effects */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-emerald-500/20 rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-blue-500/10 rounded-full blur-[100px] pointer-events-none" />
        
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-medium mb-8">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Live across all 58 Wilayas
          </div>
          
          <h1 className="text-5xl sm:text-7xl font-extrabold text-white tracking-tight mb-8">
            The trusted medical <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-cyan-400">
              verification layer
            </span>
          </h1>
          
          <p className="mt-4 max-w-2xl text-lg sm:text-xl text-slate-400 mx-auto mb-10 leading-relaxed">
            Securely verify your identity, medical diploma, and CNOM registration in seconds. Built for the modern Algerian healthcare ecosystem.
          </p>
          
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <button 
              onClick={() => navigate('/verify')}
              className="bg-emerald-600 hover:bg-emerald-500 text-white px-8 py-4 rounded-lg font-semibold text-lg transition-all transform hover:scale-105 shadow-[0_0_20px_rgba(16,185,129,0.4)] flex items-center justify-center gap-2"
            >
              Start Verification <ShieldCheck className="w-5 h-5" />
            </button>
          </div>
        </div>
      </main>

      {/* Features Grid */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 border-t border-slate-800/50">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          
          {/* Feature 1 */}
          <div className="bg-slate-800/30 border border-slate-700/50 rounded-2xl p-8 backdrop-blur-sm hover:bg-slate-800/50 transition-colors">
            <div className="w-12 h-12 bg-emerald-500/20 rounded-xl flex items-center justify-center mb-6">
              <Stethoscope className="w-6 h-6 text-emerald-400" />
            </div>
            <h3 className="text-xl font-bold text-white mb-3">CNOM Synchronization</h3>
            <p className="text-slate-400 leading-relaxed">
              Real-time cross-referencing with official regional CNOM databases to guarantee active practitioner status.
            </p>
          </div>

          {/* Feature 2 */}
          <div className="bg-slate-800/30 border border-slate-700/50 rounded-2xl p-8 backdrop-blur-sm hover:bg-slate-800/50 transition-colors">
            <div className="w-12 h-12 bg-blue-500/20 rounded-xl flex items-center justify-center mb-6">
              <Fingerprint className="w-6 h-6 text-blue-400" />
            </div>
            <h3 className="text-xl font-bold text-white mb-3">NFC Identity Extraction</h3>
            <p className="text-slate-400 leading-relaxed">
              Instant and secure data extraction from Algerian Biometric Passports using cutting-edge NFC technology.
            </p>
          </div>

          {/* Feature 3 */}
          <div className="bg-slate-800/30 border border-slate-700/50 rounded-2xl p-8 backdrop-blur-sm hover:bg-slate-800/50 transition-colors">
            <div className="w-12 h-12 bg-purple-500/20 rounded-xl flex items-center justify-center mb-6">
              <Lock className="w-6 h-6 text-purple-400" />
            </div>
            <h3 className="text-xl font-bold text-white mb-3">Military-Grade Security</h3>
            <p className="text-slate-400 leading-relaxed">
              End-to-end 256-bit encryption ensuring strict compliance with Algerian medical privacy laws.
            </p>
          </div>

        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-[#0a0f1e]/80 py-8 text-center text-slate-500 text-sm">
        <p>&copy; 2026 TrustMed. Built for the Algerian Healthcare Sector.</p>
      </footer>
    </div>
  );
}
