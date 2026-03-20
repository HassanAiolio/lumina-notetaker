import axios from 'axios';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

export const summarizeTranscript = async (transcript) => {
  const res = await axios.post(`${API}/notes/summarize`, { transcript });
  return res.data;
};

export const saveNote = async (note) => {
  const res = await axios.post(`${API}/notes`, note);
  return res.data;
};

export const getNotes = async ({ search, tag } = {}) => {
  const params = {};
  if (search) params.search = search;
  if (tag) params.tag = tag;
  const res = await axios.get(`${API}/notes`, { params });
  return res.data;
};

export const getNote = async (id) => {
  const res = await axios.get(`${API}/notes/${id}`);
  return res.data;
};

export const deleteNote = async (id) => {
  const res = await axios.delete(`${API}/notes/${id}`);
  return res.data;
};

export const updateNoteTags = async (id, tags) => {
  const res = await axios.patch(`${API}/notes/${id}/tags`, { tags });
  return res.data;
};

export const getAllTags = async () => {
  const res = await axios.get(`${API}/tags`);
  return res.data;
};
