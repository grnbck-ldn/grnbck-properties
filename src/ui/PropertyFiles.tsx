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
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const folder = propertyId;
  const images = files.filter((f) => f.isImage);

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

  useEffect(() => {
    if (lightboxIndex === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxIndex(null);
      if (e.key === "ArrowRight") setLightboxIndex((i) => i !== null ? Math.min(i + 1, images.length - 1) : null);
      if (e.key === "ArrowLeft") setLightboxIndex((i) => i !== null ? Math.max(i - 1, 0) : null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex, images.length]);

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

  function openLightbox(file: FileEntry) {
    const idx = images.findIndex((f) => f.name === file.name);
    if (idx >= 0) setLightboxIndex(idx);
  }

  return (
    <div style={{ marginTop: 24 }}>
      {/* Lightbox */}
      {lightboxIndex !== null && images[lightboxIndex] && (
        <div
          onMouseDown={() => setLightboxIndex(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 2000,
            background: "rgba(0,0,0,0.92)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          {/* Prev */}
          {lightboxIndex > 0 && (
            <button
              onMouseDown={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex - 1); }}
              style={{
                position: "absolute", left: 20, top: "50%", transform: "translateY(-50%)",
                background: "rgba(255,255,255,0.1)", border: "none", color: "#fff",
                borderRadius: 8, padding: "10px 16px", fontSize: 20, cursor: "pointer",
              }}
            >
              ‹
            </button>
          )}

          <img
            src={images[lightboxIndex].url}
            alt={images[lightboxIndex].name}
            onMouseDown={(e) => e.stopPropagation()}
            style={{ maxWidth: "90vw", maxHeight: "90vh", objectFit: "contain", borderRadius: 8 }}
          />

          {/* Next */}
          {lightboxIndex < images.length - 1 && (
            <button
              onMouseDown={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex + 1); }}
              style={{
                position: "absolute", right: 20, top: "50%", transform: "translateY(-50%)",
                background: "rgba(255,255,255,0.1)", border: "none", color: "#fff",
                borderRadius: 8, padding: "10px 16px", fontSize: 20, cursor: "pointer",
              }}
            >
              ›
            </button>
          )}

          {/* Close */}
          <button
            onMouseDown={(e) => { e.stopPropagation(); setLightboxIndex(null); }}
            style={{
              position: "absolute", top: 16, right: 16,
              background: "rgba(255,255,255,0.1)", border: "none", color: "#fff",
              borderRadius: 8, padding: "6px 12px", fontSize: 16, cursor: "pointer",
            }}
          >
            ✕
          </button>

          {/* Caption */}
          <div style={{ position: "absolute", bottom: 16, color: "rgba(255,255,255,0.5)", fontSize: 12 }}>
            {images[lightboxIndex].name} ({lightboxIndex + 1}/{images.length})
          </div>
        </div>
      )}

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
              {f.isImage ? (
                <div
                  onClick={() => openLightbox(f)}
                  style={{ cursor: "zoom-in", display: "block" }}
                >
                  <img
                    src={f.url}
                    alt={f.name}
                    style={{ width: "100%", height: 90, objectFit: "cover", display: "block" }}
                  />
                </div>
              ) : (
                <a href={f.url} target="_blank" rel="noreferrer" style={{ display: "block" }}>
                  <div style={{
                    height: 90,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 32,
                  }}>
                    📄
                  </div>
                </a>
              )}
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
