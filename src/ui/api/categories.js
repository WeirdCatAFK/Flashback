/**
 * Pedagogical categories API (/api/categories).
 */

import { request } from "./client.js";

export const getCategories = () => request("GET", "/api/categories");

export const createCategory = (data) =>
  request("POST", "/api/categories", data);

export const updateCategory = (id, data) =>
  request("PUT", `/api/categories/${id}`, data);

/** Refused (409) while cards use it, unless `clear` asks for those cards to lose it first. */
export const deleteCategory = (id, { clear = false } = {}) =>
  request("DELETE", `/api/categories/${id}${clear ? "?clear=1" : ""}`);
