import { request } from "./client.js";

export const getCategories = () => request("GET", "/api/categories");

export const createCategory = (data) =>
  request("POST", "/api/categories", data);

export const updateCategory = (id, data) =>
  request("PUT", `/api/categories/${id}`, data);

export const deleteCategory = (id, { clear = false } = {}) =>
  request("DELETE", `/api/categories/${id}${clear ? "?clear=1" : ""}`);
