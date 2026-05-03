import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ShieldCheck, Fingerprint, FileText, UploadCloud, 
  Activity, CheckCircle, AlertTriangle, Loader2 
} from 'lucide-react';
import api from '../api';

export default function VerificationPortal() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  // Form State
  const [cnom, setCnom] = useState('');
  const [fullName, setFullName] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [wilaya, setWilaya] = useState('');
  
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [diplomaFile, setDiplomaFile] = useState(null);
  const [cnomFile, setCnomFile] = useState(null);

  // Status Dashboard State
  const [trustScore, setTrustScore] = useState(0);

  const handleIdentitySubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    // Simulate NFC extraction & API registration
    setTimeout(() => {
      // Create a mock token since backend /register endpoint is not yet implemented
      localStorage.setItem('practitioner_token', 'mock_practitioner_jwt');
      localStorage.setItem('practitioner_name', fullName);
      localStorage.setItem('practitioner_cnom', cnom);
      setLoading(false);
      setStep(2);
    }, 1500);
  };

  const handleLegalSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    
    // Fallback/mock since endpoint might not exist
    setTimeout(() => {
      setLoading(false);
      setStep(3);
    }, 1000);
  };

  const handleDocumentSubmit = async (e) => {
    e.preventDefault();
    if (!diplomaFile || !cnomFile) {
      setError('Please upload both required documents.');
      return;
    }
    setLoading(true);
    
    // Mock upload delay
    setTimeout(() => {
      setLoading(false);
      setStep(4);
      // Simulate trust score increasing over time
      simulateScoreCalculation();
    }, 2000);
  };

  const simulateScoreCalculation = () => {
    let score = 0;
    const interval = setInterval(() => {
      score += 5;
      if (score >= 85) {
        clearInterval(interval);
        setTrustScore(85);
      } else {
        setTrustScore(score);
      }
    }, 150);
  };

  return (
    <div className="min-h-screen bg-[#0a0f1e] text-slate-200 font-sans selection:bg-emerald-500/30 pb-20">
      {/* Navbar */}
      <nav className="w-full border-b border-slate-800 bg-[#0a0f1e]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/')}>
            <ShieldCheck className="w-6 h-6 text-emerald-500" />
            <span className="text-lg font-bold text-white">TrustMed Portal</span>
          </div>
          <div className="text-sm text-slate-400">Step {step} of 4</div>
        </div>
      </nav>

      {/* Progress Bar */}
      <div className="w-full h-1 bg-slate-800">
        <div 
          className="h-full bg-emerald-500 transition-all duration-500 ease-out"
          style={{ width: `${(step / 4) * 100}%` }}
        />
      </div>

      <main className="max-w-2xl mx-auto px-4 mt-12">
        {error && (
          <div className="mb-6 p-4 bg-red-900/30 border border-red-500/50 rounded-lg flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <p className="text-red-200 text-sm">{error}</p>
          </div>
        )}

        {/* STEP 1: IDENTITY */}
        {step === 1 && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="text-center mb-10">
              <div className="w-16 h-16 bg-blue-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-blue-500/30">
                <Fingerprint className="w-8 h-8 text-blue-400" />
              </div>
              <h1 className="text-3xl font-bold text-white mb-2">Identity Extraction</h1>
              <p className="text-slate-400">Place your biometric passport or ID card on your device, or enter manually below.</p>
            </div>

            <form onSubmit={handleIdentitySubmit} className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 md:p-8 backdrop-blur-sm">
              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">Full Name</label>
                  <input required value={fullName} onChange={e => setFullName(e.target.value)} type="text" className="w-full bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-white focus:outline-none focus:border-emerald-500" placeholder="e.g. Dr. Ahmed Benali" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">CNOM Number</label>
                  <input required value={cnom} onChange={e => setCnom(e.target.value)} type="text" className="w-full bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-white focus:outline-none focus:border-emerald-500" placeholder="e.g. 16/8343" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1">Specialty</label>
                    <input required value={specialty} onChange={e => setSpecialty(e.target.value)} type="text" className="w-full bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-white focus:outline-none focus:border-emerald-500" placeholder="Cardiology" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1">Wilaya Code</label>
                    <input required value={wilaya} onChange={e => setWilaya(e.target.value)} type="number" min="1" max="58" className="w-full bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-white focus:outline-none focus:border-emerald-500" placeholder="16" />
                  </div>
                </div>
                
                <button type="submit" disabled={loading} className="w-full mt-6 bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50">
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Confirm Identity'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* STEP 2: LEGAL DECLARATION */}
        {step === 2 && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="text-center mb-10">
              <div className="w-16 h-16 bg-purple-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-purple-500/30">
                <FileText className="w-8 h-8 text-purple-400" />
              </div>
              <h1 className="text-3xl font-bold text-white mb-2">Legal Declaration</h1>
              <p className="text-slate-400">Please review the medical data privacy requirements.</p>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl overflow-hidden backdrop-blur-sm">
              <div className="p-6 h-64 overflow-y-auto border-b border-slate-700/50 text-sm text-slate-300 space-y-4">
                <p><strong>Article 1: Data Privacy</strong><br/>Under Algerian Law, patient medical records must be encrypted and physically stored on servers located within the national territory.</p>
                <div className="p-3 bg-red-900/20 border border-red-500/30 rounded text-red-200">
                  <strong>Warning - Art. 243 Code Pénal:</strong> Falsification of medical credentials or usurpation of a medical title is punishable by 1 to 5 years of imprisonment.
                </div>
                <p>By proceeding, you authorize TrustMed to scrape and verify your credentials against the official Regional Councils of the Order of Physicians (SORM).</p>
              </div>
              
              <div className="p-6 bg-slate-900/30">
                <form onSubmit={handleLegalSubmit}>
                  <label className="flex items-start gap-3 cursor-pointer group">
                    <div className="mt-0.5">
                      <input 
                        type="checkbox" 
                        required 
                        checked={legalAccepted}
                        onChange={(e) => setLegalAccepted(e.target.checked)}
                        className="w-5 h-5 rounded border-slate-600 text-emerald-500 focus:ring-emerald-500/20 bg-slate-800"
                      />
                    </div>
                    <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
                      I have read the declaration. I accept full criminal and civil liability for the documents I am about to upload.
                    </span>
                  </label>
                  <button type="submit" disabled={!legalAccepted || loading} className="w-full mt-6 bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50">
                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Sign & Continue'}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: DOCUMENT UPLOAD */}
        {step === 3 && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="text-center mb-10">
              <div className="w-16 h-16 bg-emerald-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-emerald-500/30">
                <UploadCloud className="w-8 h-8 text-emerald-400" />
              </div>
              <h1 className="text-3xl font-bold text-white mb-2">Document Verification</h1>
              <p className="text-slate-400">Upload high-quality photos or PDFs of your credentials.</p>
            </div>

            <form onSubmit={handleDocumentSubmit} className="space-y-6">
              {/* Diploma */}
              <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 backdrop-blur-sm relative overflow-hidden group">
                <input 
                  type="file" 
                  accept=".pdf,image/*" 
                  onChange={e => setDiplomaFile(e.target.files[0])}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                />
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-white">Medical Diploma</h3>
                    <p className="text-sm text-slate-400 mt-1">
                      {diplomaFile ? diplomaFile.name : 'Click or drag file here (Max 10MB)'}
                    </p>
                  </div>
                  {diplomaFile ? <CheckCircle className="w-6 h-6 text-emerald-500" /> : <UploadCloud className="w-6 h-6 text-slate-500 group-hover:text-emerald-400 transition-colors" />}
                </div>
              </div>

              {/* CNOM Card */}
              <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 backdrop-blur-sm relative overflow-hidden group">
                <input 
                  type="file" 
                  accept=".pdf,image/*" 
                  onChange={e => setCnomFile(e.target.files[0])}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                />
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-white">CNOM Registration Card</h3>
                    <p className="text-sm text-slate-400 mt-1">
                      {cnomFile ? cnomFile.name : 'Click or drag file here (Max 10MB)'}
                    </p>
                  </div>
                  {cnomFile ? <CheckCircle className="w-6 h-6 text-emerald-500" /> : <UploadCloud className="w-6 h-6 text-slate-500 group-hover:text-emerald-400 transition-colors" />}
                </div>
              </div>

              <button type="submit" disabled={!diplomaFile || !cnomFile || loading} className="w-full mt-8 bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50">
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Submit & Analyze'}
              </button>
            </form>
          </div>
        )}

        {/* STEP 4: STATUS DASHBOARD */}
        {step === 4 && (
          <div className="animate-in fade-in zoom-in-95 duration-500">
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-3xl p-8 md:p-12 text-center backdrop-blur-sm relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500 to-cyan-500" />
              
              <h2 className="text-2xl font-bold text-white mb-2">Dr. {fullName}</h2>
              <p className="text-slate-400 mb-10">Verification in progress</p>

              {/* Circular Gauge */}
              <div className="relative w-48 h-48 mx-auto mb-8">
                <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="8" fill="none" className="text-slate-700" />
                  <circle 
                    cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="8" fill="none" 
                    strokeDasharray="251.2" 
                    strokeDashoffset={251.2 - (251.2 * trustScore) / 100}
                    strokeLinecap="round"
                    className="text-emerald-500 transition-all duration-300 ease-out"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-4xl font-black text-white">{trustScore}</span>
                  <span className="text-xs font-medium text-emerald-500 tracking-wider">TRUST SCORE</span>
                </div>
              </div>

              {/* Status Timeline */}
              <div className="space-y-4 text-left max-w-sm mx-auto">
                <div className="flex items-center gap-3 text-emerald-400">
                  <CheckCircle className="w-5 h-5 shrink-0" />
                  <span className="text-sm font-medium">Identity Anchor Confirmed</span>
                </div>
                <div className="flex items-center gap-3 text-emerald-400">
                  <CheckCircle className="w-5 h-5 shrink-0" />
                  <span className="text-sm font-medium">Legal Declaration Signed</span>
                </div>
                <div className="flex items-center gap-3 text-emerald-400">
                  <CheckCircle className="w-5 h-5 shrink-0" />
                  <span className="text-sm font-medium">Documents Uploaded</span>
                </div>
                <div className="flex items-center gap-3 text-amber-400 animate-pulse">
                  <Loader2 className="w-5 h-5 shrink-0 animate-spin" />
                  <span className="text-sm font-medium">CNOM Verification Pending...</span>
                </div>
              </div>

            </div>
          </div>
        )}
      </main>
    </div>
  );
}
