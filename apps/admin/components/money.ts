export const rupees = (paise: number, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);

/** "6500" or "6,500.50" typed by a person -> paise. */
export const toPaise = (rupeesText: string) => Math.round(Number(rupeesText.replace(/,/g, '')) * 100);

export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const todayLocal = () => new Date().toLocaleDateString('en-CA');
export const shortDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
