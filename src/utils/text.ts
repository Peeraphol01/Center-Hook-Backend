/* -------------------------------------- Functions -------------------------------------- */

// Function ตัดข้อความให้ไม่เกินความยาวที่กำหนด
export function truncate(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
