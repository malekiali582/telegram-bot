const faNumber = new Intl.NumberFormat('fa-IR');

/** «۳ دقیقه» or «۴۵ ثانیه», rounded up. */
export function waitText(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds < 60
    ? `${faNumber.format(seconds)} ثانیه`
    : `${faNumber.format(Math.ceil(seconds / 60))} دقیقه`;
}
