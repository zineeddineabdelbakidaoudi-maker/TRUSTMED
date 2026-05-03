import axios from 'axios';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const api = axios.create({
  baseURL: `${BASE}`,
  timeout: 60000,
});

api.interceptors.request.use((config) => {
  // Use practitioner token for /v1/ routes, admin token for /admin/ routes
  const practToken = localStorage.getItem('practitioner_token');
  const adminToken = localStorage.getItem('admin_token');
  
  if (config.url?.startsWith('/v1/') && practToken) {
    config.headers.Authorization = `Bearer ${practToken}`;
  } else if (adminToken) {
    config.headers.Authorization = `Bearer ${adminToken}`;
  }
  return config;
});

// ── Admin APIs ──
export const adminLogin = (email, password) => 
  api.post('/admin/login', { email, password });

export const verifyCnom = (cnomNumber, fullName) => 
  api.post('/api/cnom/verify', { cnomNumber, fullName });

export const batchVerifyCnom = () => 
  api.post('/api/cnom/batch');

export const getProvisionalPractitioners = (page = 1, limit = 10) => 
  api.get(`/api/admin/practitioners/provisional?page=${page}&limit=${limit}`);

export const approvePractitioner = (id) => 
  api.patch(`/api/admin/practitioners/${id}/approve`);

export const rejectPractitioner = (id, reason) => 
  api.patch(`/api/admin/practitioners/${id}/reject`, { reason });

// ── Practitioner APIs ──
export const registerPractitioner = (data) =>
  api.post('/v1/practitioner/register', data);

export const getProfile = () =>
  api.get('/v1/practitioner/me');

export const recordConsent = () =>
  api.post('/v1/practitioner/consent', { privacy_policy: true, terms: true });

export const uploadDocument = (file, docType) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('doc_type', docType);
  return api.post('/v1/practitioner/documents', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000,
  });
};

// ── Vision AI APIs ──
export const analyzeDocument = (file, docType) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('doc_type', docType);
  return api.post('/api/vision/analyze', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000,
  });
};

export const compareFaces = (selfieFile, idFile) => {
  const formData = new FormData();
  formData.append('selfie', selfieFile);
  formData.append('id_card', idFile);
  return api.post('/api/vision/compare-faces', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000,
  });
};

export default api;

