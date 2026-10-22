"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

type Props = {
  title: string;
  hint: string;
  onResult: (payload: string) => void;
  onClose: () => void;
};

/** Decode a QR from a canvas, the way huji_attend.py does it for images. */
function decodeCanvas(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(data, width, height)?.data ?? null;
}

async function decodeImageFile(file: File) {
  const bitmap = await createImageBitmap(file);
  // tightly cropped screenshots lack the white quiet zone the detector needs
  const pad = 40;
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width + pad * 2;
  canvas.height = bitmap.height + pad * 2;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, pad, pad);
  return decodeCanvas(canvas);
}

/** Camera / image / pasted-text QR input, shown as a modal. */
export function QrScanner({ title, hint, onResult, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  // keep the camera loop stable even if the parent passes a new callback each render
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  });

  useEffect(() => {
    let stream: MediaStream | undefined;
    let frame = 0;
    let done = false;
    const canvas = document.createElement("canvas");

    const tick = () => {
      const video = videoRef.current;
      if (done || !video) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d", { willReadFrequently: true })!.drawImage(video, 0, 0);
        const data = decodeCanvas(canvas);
        if (data) {
          done = true;
          onResultRef.current(data);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };

    const media = navigator.mediaDevices
      ? navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      : Promise.reject(new Error("needs HTTPS or localhost"));
    media
      .then(async (s) => {
        stream = s;
        if (!videoRef.current || done) return;
        videoRef.current.srcObject = s;
        await videoRef.current.play();
        frame = requestAnimationFrame(tick);
      })
      .catch((e: Error) => setError(`Camera unavailable (${e.message}). Use an image or paste the text.`));

    return () => {
      done = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const data = await decodeImageFile(file);
    if (data) onResult(data);
    else setError("No QR code found in that image.");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded px-2 text-2xl leading-none text-zinc-500 hover:text-zinc-900 dark:hover:text-white" aria-label="Close">
            ×
          </button>
        </div>
        <p className="mb-3 text-sm text-zinc-500">{hint}</p>

        <video ref={videoRef} muted playsInline className="aspect-square w-full rounded-xl bg-black object-cover" />
        {error && <p className="mt-2 text-sm text-amber-600">{error}</p>}

        <label className="mt-4 block cursor-pointer rounded-lg border border-dashed border-zinc-300 p-3 text-center text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
          Or upload a screenshot / photo
          <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>

        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onResult(text.trim());
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="…or paste the decoded QR text"
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
          />
          <button className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-white dark:text-zinc-900">Use</button>
        </form>
      </div>
    </div>
  );
}
