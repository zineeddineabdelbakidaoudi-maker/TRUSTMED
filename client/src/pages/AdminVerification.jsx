import React, { useState, useEffect } from 'react';
import { Search, CheckCircle, XCircle, AlertTriangle, RefreshCw, Layers } from 'lucide-react';
import { 
  verifyCnom, 
  batchVerifyCnom, 
  getProvisionalPractitioners, 
  approvePractitioner, 
  rejectPractitioner 
} from '../api';

const AdminVerification = () => {
  const [cnomNumber, setCnomNumber] = useState('');
  const [fullName, setFullName] = useState('');
  const [singleResult, setSingleResult] = useState(null);
  const [loadingSingle, setLoadingSingle] = useState(false);

  const [provisionalQueue, setProvisionalQueue] = useState([]);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [batching, setBatching] = useState(false);
  const [batchResult, setBatchResult] = useState(null);

  const loadQueue = async () => {
    setLoadingQueue(true);
    try {
      const res = await getProvisionalPractitioners(page, 10);
      setProvisionalQueue(res.data.data);
      setTotalPages(res.data.totalPages);
    } catch (err) {
      console.error('Failed to load queue', err);
    } finally {
      setLoadingQueue(false);
    }
  };

  useEffect(() => {
    loadQueue();
    const interval = setInterval(loadQueue, 30000);
    return () => clearInterval(interval);
  }, [page]);

  const handleSingleVerify = async (e) => {
    e.preventDefault();
    if (!cnomNumber) return;
    setLoadingSingle(true);
    setSingleResult(null);
    try {
      const res = await verifyCnom(cnomNumber, fullName);
      setSingleResult(res.data);
    } catch (err) {
      setSingleResult({ error: err.response?.data?.message || err.message });
    } finally {
      setLoadingSingle(false);
    }
  };

  const handleBatchVerify = async () => {
    setBatching(true);
    setBatchResult(null);
    try {
      const res = await batchVerifyCnom();
      setBatchResult(res.data);
      loadQueue();
    } catch (err) {
      setBatchResult({ error: err.response?.data?.message || err.message });
    } finally {
      setBatching(false);
    }
  };

  const handleAction = async (id, action, currentCnom, currentName) => {
    try {
      if (action === 'verify') {
        setCnomNumber(currentCnom || '');
        setFullName(currentName || '');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        // Automatically trigger search? Let's just fill it in for them to click.
      } else if (action === 'approve') {
        if(window.confirm('Are you sure you want to approve this practitioner?')) {
          await approvePractitioner(id);
          loadQueue();
        }
      } else if (action === 'reject') {
        const reason = window.prompt('Enter rejection reason:');
        if (reason) {
          await rejectPractitioner(id, reason);
          loadQueue();
        }
      }
    } catch (err) {
      alert(`Action failed: ${err.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0f1e] text-slate-200 p-8">
      <div className="max-w-7xl mx-auto space-y-8">
        <h1 className="text-3xl font-bold text-white mb-8">Admin Verification Dashboard</h1>

        {/* SECTION A & B: Search and Result */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* SECTION A */}
          <div className="glass-card p-6">
            <h2 className="text-xl font-semibold text-white mb-4 flex items-center">
              <Search className="mr-2 h-5 w-5 text-emerald-400" />
              Practitioner Search
            </h2>
            <form onSubmit={handleSingleVerify} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">CNOM Number (e.g. 16/8343)</label>
                <input 
                  type="text" 
                  value={cnomNumber}
                  onChange={e => setCnomNumber(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-white focus:outline-none focus:border-emerald-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Full Name (Optional fallback)</label>
                <input 
                  type="text" 
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
              <button 
                type="submit" 
                disabled={loadingSingle}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2 px-4 rounded-md transition-colors disabled:opacity-50"
              >
                {loadingSingle ? 'Verifying...' : 'Verify Now'}
              </button>
            </form>
          </div>

          {/* SECTION B */}
          <div className="glass-card p-6">
            <h2 className="text-xl font-semibold text-white mb-4">Verification Result</h2>
            {!singleResult && !loadingSingle && (
              <div className="text-slate-500 text-center py-8">No result yet. Perform a search.</div>
            )}
            {loadingSingle && (
              <div className="flex justify-center items-center py-8">
                <RefreshCw className="animate-spin h-8 w-8 text-emerald-500" />
              </div>
            )}
            {singleResult && singleResult.error && (
              <div className="p-4 bg-red-900/30 border border-red-500/50 rounded-md text-red-200">
                {singleResult.error}
              </div>
            )}
            {singleResult && !singleResult.error && (
              <ResultCard data={singleResult} cnom={cnomNumber} />
            )}
          </div>
        </div>

        {/* SECTION D: Batch Verification */}
        <div className="glass-card p-6 border-emerald-900/50 bg-emerald-900/10">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-xl font-semibold text-emerald-400 flex items-center">
                <Layers className="mr-2 h-5 w-5" />
                Batch Verification
              </h2>
              <p className="text-sm text-slate-400 mt-1">Run background verification on up to 50 PROVISIONAL practitioners.</p>
            </div>
            <button 
              onClick={handleBatchVerify}
              disabled={batching}
              className="bg-slate-800 hover:bg-slate-700 border border-emerald-500/30 text-emerald-400 font-medium py-2 px-4 rounded-md transition-colors disabled:opacity-50 flex items-center"
            >
              {batching ? <RefreshCw className="animate-spin mr-2 h-4 w-4" /> : null}
              {batching ? 'Processing...' : 'Run Batch Verification'}
            </button>
          </div>
          {batchResult && !batchResult.error && (
            <div className="mt-4 p-4 bg-slate-800 rounded-md flex space-x-6 text-sm">
              <span className="text-white font-medium">Summary:</span>
              <span className="text-emerald-400 flex items-center"><CheckCircle className="h-4 w-4 mr-1"/> Confirmed: {batchResult.confirmed}</span>
              <span className="text-amber-400 flex items-center"><AlertTriangle className="h-4 w-4 mr-1"/> Provisional: {batchResult.provisional}</span>
              <span className="text-red-400 flex items-center"><XCircle className="h-4 w-4 mr-1"/> Mismatch: {batchResult.mismatch}</span>
            </div>
          )}
          {batchResult && batchResult.error && (
            <div className="mt-4 p-4 bg-red-900/30 border border-red-500/50 rounded-md text-red-200 text-sm">
              {batchResult.error}
            </div>
          )}
        </div>

        {/* SECTION C: Provisional Queue Table */}
        <div className="glass-card p-6 overflow-hidden">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-white">PROVISIONAL Queue</h2>
            <button onClick={loadQueue} className="text-slate-400 hover:text-white" title="Refresh">
              <RefreshCw className={`h-5 w-5 ${loadingQueue ? 'animate-spin' : ''}`} />
            </button>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-sm">
                  <th className="p-3">Name</th>
                  <th className="p-3">CNOM</th>
                  <th className="p-3">Wilaya</th>
                  <th className="p-3">Specialty</th>
                  <th className="p-3">Score</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {provisionalQueue.length === 0 ? (
                  <tr><td colSpan="6" className="p-4 text-center text-slate-500">No provisional cases.</td></tr>
                ) : (
                  provisionalQueue.map(p => (
                    <tr key={p.id} className="border-b border-slate-800 hover:bg-slate-800/50">
                      <td className="p-3 font-medium text-white">{p.full_name}</td>
                      <td className="p-3 font-mono text-sm">{p.cnom_number || 'N/A'}</td>
                      <td className="p-3 text-sm">{p.wilaya_code || 'N/A'}</td>
                      <td className="p-3 text-sm">{p.specialty || 'N/A'}</td>
                      <td className="p-3">
                        <span className="bg-slate-800 px-2 py-1 rounded text-xs">
                          {(p.last_score * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td className="p-3 text-right space-x-2">
                        <button onClick={() => handleAction(p.id, 'verify', p.cnom_number, p.full_name)} className="text-xs bg-blue-600/20 text-blue-400 border border-blue-600/30 hover:bg-blue-600/40 px-2 py-1 rounded">Verify</button>
                        <button onClick={() => handleAction(p.id, 'approve')} className="text-xs bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 hover:bg-emerald-600/40 px-2 py-1 rounded">Approve</button>
                        <button onClick={() => handleAction(p.id, 'reject')} className="text-xs bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/40 px-2 py-1 rounded">Reject</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between items-center mt-4 text-sm text-slate-400">
            <span>Showing page {page} of {totalPages}</span>
            <div className="space-x-2">
              <button disabled={page <= 1} onClick={() => setPage(p => p-1)} className="px-3 py-1 bg-slate-800 rounded hover:bg-slate-700 disabled:opacity-50">Prev</button>
              <button disabled={page >= totalPages} onClick={() => setPage(p => p+1)} className="px-3 py-1 bg-slate-800 rounded hover:bg-slate-700 disabled:opacity-50">Next</button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

// Helper component for Section B
const ResultCard = ({ data, cnom }) => {
  const isConfirmed = data.result === 'CONFIRMED';
  const isProvisional = data.result === 'PROVISIONAL';
  const isMismatch = data.result === 'MISMATCH';
  const isRetired = data.result === 'RETIRED';

  const borderColor = isConfirmed ? 'border-emerald-500' 
                    : isProvisional ? 'border-amber-500' 
                    : isMismatch ? 'border-red-500' 
                    : 'border-slate-500';

  const sourceColor = data.source === 'OFFICIAL' ? 'bg-blue-600/20 text-blue-400 border-blue-600/30'
                    : data.source === 'THIRD_PARTY' ? 'bg-purple-600/20 text-purple-400 border-purple-600/30'
                    : 'bg-slate-600/20 text-slate-400 border-slate-600/30';

  return (
    <div className={`p-5 rounded-lg border-2 bg-slate-800/80 ${borderColor}`}>
      <div className="flex justify-between items-start mb-4">
        <div className="font-mono text-lg font-bold text-white">CNOM: {cnom}</div>
        <div className={`text-xs px-2 py-1 rounded border ${sourceColor}`}>
          Source: {data.source || 'UNKNOWN'}
        </div>
      </div>
      
      <div className="space-y-2 text-sm text-slate-300">
        <div><span className="text-slate-500 w-24 inline-block">Name:</span> <span className="font-medium text-white">{data.scraped_data?.scraped_name || 'N/A'}</span></div>
        <div><span className="text-slate-500 w-24 inline-block">Specialty:</span> {data.scraped_data?.scraped_specialty || 'N/A'}</div>
        <div>
          <span className="text-slate-500 w-24 inline-block">Status:</span> 
          <span className="flex items-center inline-flex">
            <span className={`h-2 w-2 rounded-full mr-2 ${data.scraped_data?.scraped_status === 'ACTIVE' ? 'bg-emerald-500' : 'bg-slate-500'}`}></span>
            {data.scraped_data?.scraped_status || 'UNKNOWN'}
          </span>
        </div>
        <div><span className="text-slate-500 w-24 inline-block">Match Score:</span> <span className="font-mono">{(data.match_score * 100).toFixed(0)}%</span></div>
      </div>

      <div className="mt-6 pt-4 border-t border-slate-700 flex justify-between items-center">
        <div className="font-bold flex items-center">
          Result: 
          <span className={`ml-2 ${isConfirmed ? 'text-emerald-400' : isProvisional ? 'text-amber-400' : isMismatch ? 'text-red-400' : 'text-slate-400'}`}>
            {isConfirmed && '✅ '}
            {isProvisional && '⚠️ '}
            {isMismatch && '❌ '}
            {data.result}
          </span>
        </div>
        {data.scraped_data?.portal_url && (
          <a href={data.scraped_data.portal_url} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:text-blue-300 flex items-center">
            View Portal <span className="ml-1">→</span>
          </a>
        )}
      </div>
    </div>
  );
};

export default AdminVerification;
