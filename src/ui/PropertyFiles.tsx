import React, { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

const BUCKET = "property-files";

interface FileEntry {
  name: string;
  url: string;
  isImage: boolean;
}

interface Props {
  propertyId: string;
}

export function PropertyFiles({ propertyId }: Props) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const folder = propertyId;

  async function loadFiles() {
    setLoading(true);
    setError(null);
    const { data, error: listErr } = await supabase.storage.from(BUCKET).list(folder);
    if (listErr) {
      setError(listErr.message);
      setLoading(false);
      return;
    }
    const entries: FileEntry[] = (data ?? [])
      .filter((f) => f.name !== ".emptyFolderPlaceholder")
      .map((f) => {
        const path = `${folder}/${f.name}`;
        const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path);
        const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name);
        return { name: f.name, url: urlData.publicUrl, isImage };
      });
    setFiles(entries);
    setLoading(false);
  }

  useEffect(() => { loadFiles(); }, [propertyId]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    if (!picked.length) return;
    setUploading(true);
    setError(null);
    for (const file of picked) {
      const path = `${folder}/${file.name}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { upsert: true });
      if (upErr) { setError(upErr.message); break; }
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
    loadFiles();
  }

  async function deleteFile(name: string) {
    const { error: delErr } = await supabase.storage
      .from(BUCKET)
      .remove([`${folder}/${name}`]);
    if (delErr) { setError(delErr.message); return; }
    setFiles((prev) => prev.filter((f) => f.name !== name));
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div className="row between" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Files</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {uploading && <span className="small muted">Uploading...</span>}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            style={{ fontSize: 12, padding: "6px 12px" }}
          >
            + Upload
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            onChange={handleUpload}
            style={{ display: "none" }}
          />
        </div>
      </div>

      {error && (
        <p className="small" style={{ color: "#fb7185", marginBottom: 8 }}>{error}</p>
      )}

      {loading ? (
        <p className="small muted">Loading files...</p>
      ) : files.length === 0 ? (
        <p className="small muted">No files yet. Upload a floorplan or photo.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
          {files.map((f) => (
            <div
              key={f.name}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                overflow: "hidden",
                position: "relative",
              }}
            >
              <a href={f.url} target="_blank" rel="noreferrer" style={{ display: "block" }}>
                {f.isImage ? (
                  <img
                    src={f.url}
                    alt={f.name}
                    style={{ width: "100%", height: 90, objectFit: "cover", display: "block" }}
                  />
                ) : (
                  <div style={{
                    height: 90,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 32,
                  }}>
                    📄
                  </div>
                )}
              </a>
              <div style={{ padding: "6px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                <span
                  className="small"
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
                  title={f.name}
                >
                  {f.name}
                </span>
                <button
                  type="button"
                  onClick={() => deleteFile(f.name)}
                  className="danger"
                  style={{ fontSize: 11, padding: "2px 6px", flexShrink: 0 }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
