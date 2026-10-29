/**
 * SharePlace deletion ownership precondition. Never delete a TL3 release
 * merely because the caller knows its share ID or numeric file ID.
 * Some historical release rows lack user_id, so the authoritative owner
 * MUST be the backing tl_files.user_id before any destructive SQL executes.
 */
export function ownsLinkedReleaseForDeletion(
  actorId:number,
  release: {file_id?:unknown}|null,
  ownedFile: {id?:unknown;user_id?:unknown}|null
):boolean{
  if(!release)return true; // unlinked own share or verified legacy file path
  const linkedId=Number(release.file_id);
  if(!Number.isSafeInteger(actorId)||actorId<=0||
     !Number.isSafeInteger(linkedId)||linkedId<=0||
     !ownedFile)return false;
  return Number(ownedFile.id)===linkedId && Number(ownedFile.user_id)===actorId;
}
