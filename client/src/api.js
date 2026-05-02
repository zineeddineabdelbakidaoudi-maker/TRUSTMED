import axios from 'axios';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const api = axios.create({
  baseURL: `${BASE}`,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token'); // Mocking admin token for now
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

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

export default api;
