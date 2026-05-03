import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ShieldCheck, Fingerprint, FileText, UploadCloud, Camera,
  Activity, CheckCircle, AlertTriangle, Loader2, XCircle, ScanFace
} from 'lucide-react';
import { registerPractitioner, recordConsent, analyzeDocument, compareFaces, getProfile } from '../api';

export default function VerificationPortal() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  // Step 1: Identity
  const [cnom, setCnom] = useState('');
  const [fullName, setFullName] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [wilaya, setWilaya] = useState('');
  const [practitionerId, setPractitionerId] = useState('');

  // Step 3: Documents
  const [diplomaFile, setDiplomaFile] = useState(null);
  const [cnomFile, setCnomFile] = useState(null);
  const [diplomaResult, setDiplomaResult] = useState(null);
  const [cnomResult, setCnomResult] = useState(null);
  
  // Step 4: Face Liveness
  const [idFile, setIdFile] = useState(null);
  const [selfieFile, setSelfieFile] = useState(null);
  const [faceResult, setFaceResult] = useState(null);

  // Step 5: Status Dashboard
  const [trustScore, setTrustScore] = useState(0);
  const [verificationStatus, setVerificationStatus] = useState('IDENTITY_PENDING');
  const [badgeLevel, setBadgeLevel] = useState('NONE');
  const pollingRef = useRef(null);

  // Steps completed tracker
  const [completed, setCompleted] = useState({
    identity: false,
    legal: false,
    documents: false,
    liveness: false,
  });

  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  // ── STEP 1: Registration ──
  const handleIdentitySubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await registerPractitioner({
        full_name: fullName,
        cnom_number: cnom,
        specialty: specialty,
        wilaya_code: wilaya,
      });
      
      localStorage.setItem('practitioner_token', res.data.access_token);
      localStorage.setItem('practitioner_id', res.data.practitioner_id);
      setPractitionerId(res.data.practitioner_id);
      setCompleted(prev => ({ ...prev, identity: true }));
      setStep(2);
    } catch (err) {
      setError(err.response?.data?.message || 'Registration failed. Backend may be unreachable.');
    } finally {
      setLoading(false);
    }
  };

  // ── STEP 2: Legal Declaration ──
  const [legalAccepted, setLegalAccepted] = useState(false);

  const handleLegalSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await recordConsent();
      setCompleted(prev => ({ ...prev, legal: true }));
      setStep(3);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to record consent.');
    } finally {
      setLoading(false);
    }
  };

  // ── STEP 3: Document Upload + AI Analysis ──
  const handleDocumentSubmit = async (e) => {
    e.preventDefault();
    if (!diplomaFile || !cnomFile) {
      setError('Please upload both required documents.');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      // Analyze Diploma with Vision AI
      setSuccess('🔬 Analyzing Medical Diploma with AI...');
      const diplomaRes = await analyzeDocument(diplomaFile, 'DIPLOMA');
      setDiplomaResult(diplomaRes.data);

      if (!diplomaRes.data.is_authentic) {
        setError(`❌ DIPLOMA REJECTED: ${diplomaRes.data.details?.Gemini?.reason || diplomaRes.data.details?.Groq_Llama4Scout?.reason || 'Not a valid medical diploma or detected as fraudulent.'}`);
        setLoading(false);
        setSuccess('');
        return;
      }

      // Analyze CNOM Card
      setSuccess('🔬 Analyzing CNOM Card with AI...');
      const cnomRes = await analyzeDocument(cnomFile, 'CNOM_CARD');
      setCnomResult(cnomRes.data);

      setSuccess('✅ Both documents passed AI verification!');
      setCompleted(prev => ({ ...prev, documents: true }));
      
      setTimeout(() => {
        setSuccess('');
        setStep(4);
      }, 1500);
    } catch (err) {
      setError(err.response?.data?.message || 'Document analysis failed.');
      setSuccess('');
    } finally {
      setLoading(false);
    }
  };

  // ── STEP 4: Face Liveness ──
  const handleFaceLiveness = async (e) => {
    e.preventDefault();
    if (!selfieFile || !idFile) {
      setError('Please upload both your selfie and ID card.');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      setSuccess('🧬 Comparing face biometrics with AI...');
      const res = await compareFaces(selfieFile, idFile);
      setFaceResult(res.data);

      if (!res.data.matched) {
        setError(`❌ FACE MISMATCH: ${res.data.reason || 'The selfie does not match the ID card photo.'}`);
        setLoading(false);
        setSuccess('');
        return;
      }

      setSuccess(`✅ Face matched with ${res.data.confidence}% confidence!`);
      setCompleted(prev => ({ ...prev, liveness: true }));
      
      setTimeout(() => {
        setSuccess('');
        setStep(5);
        startPolling();
      }, 1500);
    } catch (err) {
      setError(err.response?.data?.message || 'Face comparison failed.');
      setSuccess('');
    } finally {
      setLoading(false);
    }
  };

  // ── STEP 5: Live Score Polling ──
  const startPolling = () => {
    const fetchScore = async () => {
      try {
        const res = await getProfile();
        const data = res.data;
        setTrustScore(data.trust_score || 0);
        setVerificationStatus(data.verification_status || 'PENDING');
        setBadgeLevel(data.badge_level || 'NONE');
      } catch {
        // Silently fail polling
      }
    };
    fetchScore();
    pollingRef.current = setInterval(fetchScore, 5000);
  };

  const totalSteps = 5;

  return (
    <div className="min-h-screen bg-[#0a0f1e] text-slate-200 font-sans selection:bg-emerald-500/30 pb-20">
      {/* Navbar */}
      <nav className="w-full border-b border-slate-800 bg-[#0a0f1e]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/')}>
            <ShieldCheck className="w-6 h-6 text-emerald-500" />
            <span className="text-lg font-bold text-white">TrustMed Portal</span>
          </div>
          <div className="text-sm text-slate-400">Step {step} of {totalSteps}</div>
        </div>
      </nav>

      {/* Progress Bar */}
      <div className="w-full h-1 bg-slate-800">
        <div className="h-full bg-emerald-500 transition-all duration-500 ease-out" style={{ width: `${(step / totalSteps) * 100}%` }} />
      </div>

      <main className="max-w-2xl mx-auto px-4 mt-12">
        {error && (
          <div className="mb-6 p-4 bg-red-900/30 border border-red-500/50 rounded-lg flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <p className="text-red-200 text-sm">{error}</p>
          </div>
        )}
        {success && (
          <div className="mb-6 p-4 bg-emerald-900/30 border border-emerald-500/50 rounded-lg flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <p className="text-emerald-200 text-sm">{success}</p>
          </div>
        )}

        {/* ════════════ STEP 1: IDENTITY ════════════ */}
        {step === 1 && (
          <div>
            <div className="text-center mb-10">
              <div className="w-16 h-16 bg-blue-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-blue-500/30">
                <Fingerprint className="w-8 h-8 text-blue-400" />
              </div>
              <h1 className="text-3xl font-bold text-white mb-2">Identity Registration</h1>
              <p className="text-slate-400">Enter your professional information to start the verification process.</p>
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
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Register & Continue'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ════════════ STEP 2: LEGAL DECLARATION ════════════ */}
        {step === 2 && (
          <div>
            <div className="text-center mb-10">
              <div className="w-16 h-16 bg-purple-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-purple-500/30">
                <FileText className="w-8 h-8 text-purple-400" />
              </div>
              <h1 className="text-3xl font-bold text-white mb-2">Legal Declaration</h1>
              <p className="text-slate-400">Review the legal requirements before submitting your documents.</p>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl overflow-hidden backdrop-blur-sm">
              <div className="p-6 h-64 overflow-y-auto border-b border-slate-700/50 text-sm text-slate-300 space-y-4">
                <p><strong>Article 1: Data Privacy</strong><br/>Under Algerian Law, patient medical records must be encrypted and physically stored on servers located within the national territory.</p>
                <div className="p-3 bg-red-900/20 border border-red-500/30 rounded text-red-200">
                  <strong>⚠️ Warning — Art. 243 Code Pénal:</strong> Falsification of medical credentials or usurpation of a medical title is punishable by 1 to 5 years of imprisonment and a fine of 100,000 to 500,000 DZD.
                </div>
                <p><strong>Article 2: AI Document Analysis</strong><br/>By proceeding, you authorize TrustMed to analyze your uploaded documents using Multi-Model Vision AI (Gemini, GPT-4o) to verify authenticity and detect forgery patterns.</p>
                <p><strong>Article 3: Face Verification</strong><br/>A live selfie will be compared against your national ID card photo using biometric AI to confirm your identity.</p>
              </div>
              <div className="p-6 bg-slate-900/30">
                <form onSubmit={handleLegalSubmit}>
                  <label className="flex items-start gap-3 cursor-pointer group">
                    <div className="mt-0.5">
                      <input type="checkbox" required checked={legalAccepted} onChange={(e) => setLegalAccepted(e.target.checked)} className="w-5 h-5 rounded border-slate-600 text-emerald-500 focus:ring-emerald-500/20 bg-slate-800" />
                    </div>
                    <span className="text-sm text-slate-300 group-hover:text-white transition-colors">I accept full criminal and civil liability for the documents I am about to upload. I understand that AI will analyze my submissions for fraud.</span>
                  </label>
                  <button type="submit" disabled={!legalAccepted || loading} className="w-full mt-6 bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50">
                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Sign & Continue'}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* ════════════ STEP 3: DOCUMENT UPLOAD + AI ════════════ */}
        {step === 3 && (
          <div>
            <div className="text-center mb-10">
              <div className="w-16 h-16 bg-emerald-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-emerald-500/30">
                <UploadCloud className="w-8 h-8 text-emerald-400" />
              </div>
              <h1 className="text-3xl font-bold text-white mb-2">Document Verification</h1>
              <p className="text-slate-400">Upload your credentials. AI will instantly analyze them for authenticity.</p>
            </div>
            <form onSubmit={handleDocumentSubmit} className="space-y-6">
              {/* Diploma */}
              <div className={`bg-slate-800/40 border rounded-2xl p-6 backdrop-blur-sm relative overflow-hidden group ${diplomaResult?.is_authentic === false ? 'border-red-500/50' : diplomaResult?.is_authentic ? 'border-emerald-500/50' : 'border-slate-700/50'}`}>
                <input type="file" accept=".pdf,image/*" onChange={e => { setDiplomaFile(e.target.files[0]); setDiplomaResult(null); }} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-white">Medical Diploma</h3>
                    <p className="text-sm text-slate-400 mt-1">{diplomaFile ? diplomaFile.name : 'Click or drag file here (Max 10MB)'}</p>
                    {diplomaResult && (
                      <p className={`text-xs mt-2 font-semibold ${diplomaResult.is_authentic ? 'text-emerald-400' : 'text-red-400'}`}>
                        AI Score: {diplomaResult.score}/100 — {diplomaResult.is_authentic ? 'AUTHENTIC' : 'REJECTED'}
                      </p>
                    )}
                  </div>
                  {diplomaResult?.is_authentic === false ? <XCircle className="w-6 h-6 text-red-500" /> : diplomaFile ? <CheckCircle className="w-6 h-6 text-emerald-500" /> : <UploadCloud className="w-6 h-6 text-slate-500 group-hover:text-emerald-400 transition-colors" />}
                </div>
              </div>
              {/* CNOM Card */}
              <div className={`bg-slate-800/40 border rounded-2xl p-6 backdrop-blur-sm relative overflow-hidden group ${cnomResult?.is_authentic === false ? 'border-red-500/50' : cnomResult?.is_authentic ? 'border-emerald-500/50' : 'border-slate-700/50'}`}>
                <input type="file" accept=".pdf,image/*" onChange={e => { setCnomFile(e.target.files[0]); setCnomResult(null); }} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-white">CNOM Registration Card</h3>
                    <p className="text-sm text-slate-400 mt-1">{cnomFile ? cnomFile.name : 'Click or drag file here (Max 10MB)'}</p>
                  </div>
                  {cnomFile ? <CheckCircle className="w-6 h-6 text-emerald-500" /> : <UploadCloud className="w-6 h-6 text-slate-500 group-hover:text-emerald-400 transition-colors" />}
                </div>
              </div>
              <button type="submit" disabled={!diplomaFile || !cnomFile || loading} className="w-full mt-8 bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50">
                {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> AI Analyzing...</> : '🔬 Submit & Analyze with AI'}
              </button>
            </form>
          </div>
        )}

        {/* ════════════ STEP 4: FACE LIVENESS ════════════ */}
        {step === 4 && (
          <div>
            <div className="text-center mb-10">
              <div className="w-16 h-16 bg-cyan-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-cyan-500/30">
                <ScanFace className="w-8 h-8 text-cyan-400" />
              </div>
              <h1 className="text-3xl font-bold text-white mb-2">Face Liveness Check</h1>
              <p className="text-slate-400">Upload your ID card and a live selfie. AI will verify they match.</p>
            </div>
            <form onSubmit={handleFaceLiveness} className="space-y-6">
              {/* ID Card */}
              <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 backdrop-blur-sm relative overflow-hidden group">
                <input type="file" accept="image/*" onChange={e => setIdFile(e.target.files[0])} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-white">🪪 National ID Card / Passport</h3>
                    <p className="text-sm text-slate-400 mt-1">{idFile ? idFile.name : 'Upload a clear photo of your ID card'}</p>
                  </div>
                  {idFile ? <CheckCircle className="w-6 h-6 text-emerald-500" /> : <UploadCloud className="w-6 h-6 text-slate-500 group-hover:text-cyan-400 transition-colors" />}
                </div>
              </div>
              {/* Selfie */}
              <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 backdrop-blur-sm relative overflow-hidden group">
                <input type="file" accept="image/*" capture="user" onChange={e => setSelfieFile(e.target.files[0])} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-white">📸 Live Selfie</h3>
                    <p className="text-sm text-slate-400 mt-1">{selfieFile ? selfieFile.name : 'Take a selfie or upload a recent photo'}</p>
                  </div>
                  {selfieFile ? <CheckCircle className="w-6 h-6 text-emerald-500" /> : <Camera className="w-6 h-6 text-slate-500 group-hover:text-cyan-400 transition-colors" />}
                </div>
              </div>
              {faceResult && (
                <div className={`p-4 rounded-lg border ${faceResult.matched ? 'bg-emerald-900/20 border-emerald-500/30' : 'bg-red-900/20 border-red-500/30'}`}>
                  <p className={`text-sm font-semibold ${faceResult.matched ? 'text-emerald-400' : 'text-red-400'}`}>
                    {faceResult.matched ? `✅ Match: ${faceResult.confidence}% confidence` : `❌ ${faceResult.reason}`}
                  </p>
                </div>
              )}
              <button type="submit" disabled={!selfieFile || !idFile || loading} className="w-full mt-8 bg-cyan-600 hover:bg-cyan-500 text-white py-3 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50">
                {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Comparing Faces...</> : '🧬 Verify Face Match'}
              </button>
            </form>
          </div>
        )}

        {/* ════════════ STEP 5: STATUS DASHBOARD ════════════ */}
        {step === 5 && (
          <div>
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-3xl p-8 md:p-12 text-center backdrop-blur-sm relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500 to-cyan-500" />
              <h2 className="text-2xl font-bold text-white mb-2">Dr. {fullName}</h2>
              <p className="text-slate-400 mb-10">Verification in progress</p>
              {/* Circular Gauge */}
              <div className="relative w-48 h-48 mx-auto mb-8">
                <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="8" fill="none" className="text-slate-700" />
                  <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="8" fill="none" strokeDasharray="251.2" strokeDashoffset={251.2 - (251.2 * trustScore) / 100} strokeLinecap="round" className="text-emerald-500 transition-all duration-1000 ease-out" />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-4xl font-black text-white">{trustScore}</span>
                  <span className="text-xs font-medium text-emerald-500 tracking-wider">TRUST SCORE</span>
                </div>
              </div>
              {/* Timeline */}
              <div className="space-y-4 text-left max-w-sm mx-auto">
                <div className={`flex items-center gap-3 ${completed.identity ? 'text-emerald-400' : 'text-slate-500'}`}>
                  <CheckCircle className="w-5 h-5 shrink-0" />
                  <span className="text-sm font-medium">Identity Registered</span>
                </div>
                <div className={`flex items-center gap-3 ${completed.legal ? 'text-emerald-400' : 'text-slate-500'}`}>
                  <CheckCircle className="w-5 h-5 shrink-0" />
                  <span className="text-sm font-medium">Legal Declaration Signed</span>
                </div>
                <div className={`flex items-center gap-3 ${completed.documents ? 'text-emerald-400' : 'text-slate-500'}`}>
                  <CheckCircle className="w-5 h-5 shrink-0" />
                  <span className="text-sm font-medium">Documents AI-Verified</span>
                </div>
                <div className={`flex items-center gap-3 ${completed.liveness ? 'text-emerald-400' : 'text-slate-500'}`}>
                  <CheckCircle className="w-5 h-5 shrink-0" />
                  <span className="text-sm font-medium">Face Liveness Confirmed</span>
                </div>
                <div className="flex items-center gap-3 text-amber-400 animate-pulse">
                  <Loader2 className="w-5 h-5 shrink-0 animate-spin" />
                  <span className="text-sm font-medium">CNOM Cross-Reference Pending...</span>
                </div>
              </div>
              <div className="mt-8 p-3 bg-slate-900/50 rounded-lg border border-slate-700">
                <p className="text-xs text-slate-400">Status: <span className="text-emerald-400 font-semibold">{verificationStatus}</span> • Badge: <span className="text-cyan-400 font-semibold">{badgeLevel.replace(/_/g, ' ')}</span></p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
