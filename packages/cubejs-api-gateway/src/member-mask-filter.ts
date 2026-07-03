import { underscore } from 'inflection';

/** Maps `cube.member` paths to orchestrator row keys (`cube__member`). */
export function memberPathToRowKey(memberPath: string): string {
  const lowercaseName = memberPath.toLowerCase();
  if (lowercaseName === '__user' || lowercaseName === '__cubejoinfield') {
    return memberPath;
  }
  return underscore(memberPath).replace(/\./g, '__');
}

export function resolveRowKey(
  row: Record<string, unknown>,
  memberPath: string,
): string | null {
  if (memberPath in row) {
    return memberPath;
  }
  const rowKey = memberPathToRowKey(memberPath);
  if (rowKey in row) {
    return rowKey;
  }
  return null;
}

export function remapFilterMemberToRowKey(filter: any): any {
  if (!filter) {
    return filter;
  }
  if (filter.and) {
    return { and: filter.and.map(remapFilterMemberToRowKey) };
  }
  if (filter.or) {
    return { or: filter.or.map(remapFilterMemberToRowKey) };
  }
  const member = filter.member || filter.dimension || filter.measure;
  if (typeof member === 'string' && member.includes('.')) {
    return {
      ...filter,
      member: memberPathToRowKey(member),
    };
  }
  return filter;
}

function rowMatchesLeafFilter(row: Record<string, unknown>, filter: any): boolean {
  const member = filter.member || filter.dimension || filter.measure;
  const rowKey = member && resolveRowKey(row, member);
  if (!rowKey) {
    return false;
  }
  const cellValue = row[rowKey];
  const values = (filter.values || []).map((item: unknown) => String(item));
  const value = cellValue == null ? '' : String(cellValue);

  switch (filter.operator) {
    case 'equals':
      return values.length > 0 && values.every((item: string) => item === value);
    case 'notEquals':
      return values.length > 0 && values.every((item: string) => item !== value);
    case 'contains':
      return values.some((item: string) => value.includes(item));
    case 'notContains':
      return values.every((item: string) => !value.includes(item));
    case 'startsWith':
      return values.some((item: string) => value.startsWith(item));
    case 'endsWith':
      return values.some((item: string) => value.endsWith(item));
    case 'gt':
      return values.length === 1 && Number(value) > Number(values[0]);
    case 'gte':
      return values.length === 1 && Number(value) >= Number(values[0]);
    case 'lt':
      return values.length === 1 && Number(value) < Number(values[0]);
    case 'lte':
      return values.length === 1 && Number(value) <= Number(values[0]);
    case 'set':
      return value !== '' && value != null;
    case 'notSet':
      return value === '' || value == null;
    default:
      return false;
  }
}

export function rowMatchesMaskFilter(row: Record<string, unknown>, filter: any): boolean {
  if (!filter) {
    return false;
  }
  if (filter.and) {
    return filter.and.every((item: any) => rowMatchesMaskFilter(row, item));
  }
  if (filter.or) {
    return filter.or.some((item: any) => rowMatchesMaskFilter(row, item));
  }
  return rowMatchesLeafFilter(row, filter);
}
