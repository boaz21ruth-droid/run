-- name: InsertFile :one
INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256,
                   width, height, uploaded_by_type, uploaded_by_id)
VALUES (@storage_key, @visibility, @purpose, @mime_type, @size_bytes, @sha256,
        @width, @height, @uploaded_by_type, @uploaded_by_id)
RETURNING id;

-- name: GetFile :one
SELECT id, storage_key, visibility, mime_type, size_bytes, sha256
FROM files
WHERE id = @id;

-- name: CountOtherFilesWithSHA256 :one
SELECT count(*) FROM files
WHERE sha256 = @sha256 AND purpose = @purpose AND id <> @exclude_id;
