function rowMatchesLeafFilter(row: Record<string, unknown>, filter: any): boolean {
  const member = filter.member || filter.dimension || filter.measure;
  if (!member || !(member in row)) {
    return false;
  }
  const cellValue = row[member];
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
