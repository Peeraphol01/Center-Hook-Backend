/* -------------------------------------- Types -------------------------------------- */

export interface LineProfileRecord {
  line_user_id: string;
  // null = ดึงจาก LINE ไม่ได้ (บล็อก OA, ไม่ใช่เพื่อน, id ไม่ใช่ user/group)
  display_name: string | null;
  picture_url: string | null;
  fetched_at: Date;
}

export interface LineProfileDto {
  display_name: string | null;
  picture_url: string | null;
}
