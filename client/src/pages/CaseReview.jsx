import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, ShieldCheck, User, MapPin, Stethoscope, 
  FileText, Phone, CheckCircle, XCircle, AlertTriangle, Loader2 
} from 'lucide-react';
import api from '../api';

export default function CaseReview() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    fetchCaseData();
  }, [id]);

  const fetchCaseData = async () => {
    try {
      // If the backend /admin/cases endpoint exists, we would call it:
      // const response = await api.get(`/api/admin/cases/${id}`);
      // setData(response.data);
      
      // Since we're rapidly mocking the UI flow to complete the interfaces:
      setTimeout(() => {
        setData({
          practitioner: {
            id: id,
            full_name: 'Dr. Ahmed Benali',
            cnom_number: '16/8343',
            specialty: 'Cardiology',
            wilaya_code: '16',
            verification_status: 'PENDING',
            trust_score: 65,
            badge_level: 'IDENTITY_VERIFIED'
          },
          documents: [
            { id: '1', doc_type: 'CNOM_CARD', status: 'UPLOADED', created_at: new Date().toISOString() },
            { id: '2', doc_type: 'DIPLOMA', status: 'VERIFIED', created_at: new Date().toISOString() }
          ],
          cnom_verification: {
            scraped_name: 'BENALI AHMED',
            scraped_specialty: 'CARDIOLOGIE',
            scraped_status: 'ACTIVE',
            match_score: 0.95
          }
        });
        setLoading(false);
      }, 1000);
    } catch (err) {
      setError('Failed to load case data.');
      setLoading(false);
    }
  };

  const handleAction = async (action) => {
    setActionLoading(true);
    try {
      if (action === 'approve') {
        await api.patch(`/api/admin/practitioners/${id}/approve`);
      } else if (action === 'reject') {
        if (!notes) {
          setError('Notes are required for rejection.');
          setActionLoading(false);
          return;
        }
        await api.patch(`/api/admin/practitioners/${id}/reject`, { reason: notes });
      }
      
      // Simulate success and navigate back
      setTimeout(() => {
        navigate('/admin/verification');
      }, 800);
    } catch (err) {
      setError(`Failed to ${action} practitioner.`);
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="min-h-screen bg-[#0a0f1e] text-slate-200 font-sans p-6 pb-20">
      <div className="max-w-5xl mx-auto">
        
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <button 
            onClick={() => navigate('/admin/verification')}
            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-5 h-5" /> Back to Queue
          </button>
          <div className="px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-semibold flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Case Review Active
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-900/30 border border-red-500/50 rounded-lg flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <p className="text-red-200 text-sm">{error}</p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Main Info Column */}
          <div className="lg:col-span-2 space-y-6">
            
            {/* Identity Card */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 backdrop-blur-sm">
              <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
                <User className="w-5 h-5 text-blue-400" /> Identity Information
              </h2>
              <div className="grid grid-cols-2 gap-y-6 gap-x-4">
                <div>
                  <p className="text-sm text-slate-400 mb-1">Full Name</p>
                  <p className="font-semibold text-white text-lg">{data.practitioner.full_name}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400 mb-1">CNOM Number</p>
                  <p className="font-semibold text-white text-lg">{data.practitioner.cnom_number}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400 mb-1 flex items-center gap-1">
                    <Stethoscope className="w-4 h-4" /> Specialty
                  </p>
                  <p className="font-medium text-slate-200">{data.practitioner.specialty}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400 mb-1 flex items-center gap-1">
                    <MapPin className="w-4 h-4" /> Wilaya
                  </p>
                  <p className="font-medium text-slate-200">{data.practitioner.wilaya_code}</p>
                </div>
              </div>
            </div>

            {/* CNOM Scraper Results */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 backdrop-blur-sm">
              <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" /> SORM Verification Results
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-slate-900/50 rounded-xl border border-slate-700">
                  <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Scraped Name</p>
                  <p className="font-medium text-slate-200">{data.cnom_verification.scraped_name}</p>
                </div>
                <div className="p-4 bg-slate-900/50 rounded-xl border border-slate-700">
                  <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Status</p>
                  <div className="inline-flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle className="w-4 h-4" /> {data.cnom_verification.scraped_status}
                  </div>
                </div>
                <div className="col-span-2 p-4 bg-emerald-900/10 border border-emerald-500/20 rounded-xl flex items-center justify-between">
                  <div>
                    <p className="text-sm text-emerald-400/80 mb-0.5">Match Confidence</p>
                    <p className="text-emerald-400 font-bold text-xl">{(data.cnom_verification.match_score * 100).toFixed(0)}%</p>
                  </div>
                  <ShieldCheck className="w-8 h-8 text-emerald-500/50" />
                </div>
              </div>
            </div>

            {/* Documents */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 backdrop-blur-sm">
              <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
                <FileText className="w-5 h-5 text-amber-400" /> Submitted Documents
              </h2>
              <div className="space-y-3">
                {data.documents.map(doc => (
                  <div key={doc.id} className="flex items-center justify-between p-4 bg-slate-900/50 rounded-xl border border-slate-700 hover:border-slate-500 transition-colors cursor-pointer">
                    <div className="flex items-center gap-3">
                      <FileText className="w-5 h-5 text-slate-400" />
                      <div>
                        <p className="font-medium text-slate-200">{doc.doc_type}</p>
                        <p className="text-xs text-slate-500">Uploaded {new Date(doc.created_at).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <span className={`text-xs font-semibold px-2 py-1 rounded ${
                      doc.status === 'VERIFIED' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                    }`}>
                      {doc.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>

          </div>

          {/* Sidebar Actions Column */}
          <div className="space-y-6">
            
            {/* Trust Score Card */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 backdrop-blur-sm text-center">
              <h3 className="text-slate-400 font-medium mb-4">Current Trust Score</h3>
              <div className="text-5xl font-black text-white mb-2">{data.practitioner.trust_score}</div>
              <p className="text-sm font-semibold text-emerald-400 bg-emerald-500/10 inline-block px-3 py-1 rounded-full">
                {data.practitioner.badge_level.replace('_', ' ')}
              </p>
            </div>

            {/* Decision Panel */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 backdrop-blur-sm">
              <h3 className="font-bold text-white mb-4">Case Decision</h3>
              
              <div className="mb-4">
                <label className="block text-sm text-slate-400 mb-2">Reviewer Notes</label>
                <textarea 
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  className="w-full bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-slate-200 focus:outline-none focus:border-emerald-500 resize-none h-24"
                  placeholder="Add notes for audit trail..."
                />
              </div>

              <div className="space-y-3">
                <button 
                  onClick={() => handleAction('approve')}
                  disabled={actionLoading}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                >
                  {actionLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <><CheckCircle className="w-5 h-5" /> Approve Case</>}
                </button>
                <button 
                  onClick={() => handleAction('reject')}
                  disabled={actionLoading}
                  className="w-full bg-red-600 hover:bg-red-500 text-white py-3 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                >
                  {actionLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <><XCircle className="w-5 h-5" /> Reject Case</>}
                </button>
                <button 
                  disabled={actionLoading}
                  className="w-full bg-slate-700 hover:bg-slate-600 text-white py-3 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                >
                  Request More Info
                </button>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
