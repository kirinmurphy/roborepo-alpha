// Enrollment answers "which features has the user enabled for this repository?" — distinct from
// discovery (registry membership) and from capabilities (data exists / can be queried). A repo can
// be discovered, resolved, and active while every domain enrollment stays disabled.

export function isEnrolled(record, domain) {
  return record?.enrollments?.[domain]?.enabled === true;
}

export function enrollmentSourceId(record, domain) {
  return record?.enrollments?.[domain]?.sourceId ?? null;
}
