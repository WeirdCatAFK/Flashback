import { CAPABILITIES, ROLES } from '../../shared/roles.js';

export function roleLabel(t, role) {
    switch (role) {
        case ROLES.AUTHOR:       return t('Author');
        case ROLES.ADMIN:        return t('Admin');
        case ROLES.COLLABORATOR: return t('Collaborator');
        case ROLES.READER:       return t('Reader');
        default:                 return null;
    }
}

export function capabilityHint(t, capability) {
    const minimum = CAPABILITIES[capability]?.minimum;
    const label = roleLabel(t, minimum);
    if (!label) return null;
    return t('Requires the {role} role on this server.', { role: label });
}

export function progressScopeLabels(t) {
    return {
        you: t('You'),
        pickerLabel: t('Progress of'),
        viewing: (name) => t("Viewing {name}'s progress", { name }),
    };
}
