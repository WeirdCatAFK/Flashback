import { vaultNameError } from '../../../shared/vaultName.js';
import { identityError } from '../../../shared/identity.js';

export const SCHEDULERS = [
  { value: 'leitner', label: 'Leitner' },
  { value: 'sm2', label: 'SM-2' },
  { value: 'fsrs', label: 'FSRS' },
];

export function nameError(v, t) {
  switch (vaultNameError(v)) {
    case "required":      return t("Required.");
    case "invalid-chars": return t("Contains invalid characters.");
    case "too-long":      return t("Too long (max 64 characters).");
    case "trailing-dot":  return t("Cannot end with a dot or a space.");
    case "reserved":      return t("That name is reserved.");
    default:              return null;
  }
}

export function joinPath(...parts) {
  return parts.join("\\").replace(/\\+/g, "\\");
}

export function identityProblem(identity, t) {
  const problem = identityError(identity);
  if (!problem) return null;
  switch (problem.code) {
    case "required":       return problem.field === "name" ? t("A name is required.") : t("An email is required.");
    case "invalid-chars":  return t("Contains characters that cannot be used here.");
    case "too-long":       return t("Too long (max 128 characters).");
    case "not-an-address": return t("That does not look like an email address.");
    default:               return t("Something went wrong.");
  }
}

export function bothBlank({ name, email }) {
  return !name.trim() && !email.trim();
}

export function configFromForm(form) {
  const config = {
    port: form.port,
    logFormat: form.logFormat,
    host: 'localhost',
    isLocalhost: true,
    isCustomPath: form.isCustomPath,
    customPath: form.customPath.trim(),
    vaultName: form.vaultName.trim(),
  };
  if (!bothBlank({ name: form.userName, email: form.userEmail })) {
    config.user = { name: form.userName.trim(), email: form.userEmail.trim() };
  }
  return config;
}
