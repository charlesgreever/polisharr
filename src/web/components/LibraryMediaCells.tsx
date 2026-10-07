import { useState } from "react";
import { api, formatSize, type LibraryRow } from "../api";
import { libraryRowView } from "../library-row";
import { EncodeTargetSelect } from "./EncodeTargetSelect";
import { RowActions } from "./RowActions";
import { ActionNote, Pill, PillList, PlanStatus, Tip, VideoLabel } from "./ui";

export function LibraryMediaHeaders({
  onQuality,
  onSize,
  actionsTip,
  encodeTarget = false,
  encodeTargetTip,
}: {
  onQuality?: () => void;
  onSize?: () => void;
  actionsTip?: string;
  encodeTarget?: boolean;
  encodeTargetTip?: string;
}) {
  return (
    <>
      <th>{onQuality ? <button type="button" onClick={onQuality}>Quality</button> : "Quality"}</th>
      <th>Codec</th>
      <th>{onSize ? <button type="button" onClick={onSize}>Size</button> : "Size"}</th>
      <th>Audio</th>
      <th>Subtitles</th>
      <th>Plan</th>
      {encodeTarget ? (
        <th>
          <span className="inline-flex items-center gap-1">
            Encode target
            {encodeTargetTip ? <Tip label="Encode target">{encodeTargetTip}</Tip> : null}
          </span>
        </th>
      ) : null}
      <th>
        <span className="inline-flex items-center gap-1">
          Actions
          {actionsTip ? <Tip label="Actions">{actionsTip}</Tip> : null}
        </span>
      </th>
    </>
  );
}

export function LibraryMediaCells({
  item,
  onDone,
  onHealth,
  houseVideoTarget = "hevc",
  av1Available = false,
  encodeTarget = false,
}: {
  item: LibraryRow;
  onDone: () => void;
  onHealth?: (health: { healthyCount: number; suggestionCount: number }) => void;
  houseVideoTarget?: "hevc" | "av1";
  av1Available?: boolean;
  encodeTarget?: boolean;
}) {
  const view = libraryRowView(item);
  return (
    <>
      <td className="whitespace-nowrap">
        {item.quality ? <Pill>{item.quality}</Pill> : <span className="text-muted">—</span>}
      </td>
      <td><VideoLabel label={view.video} /></td>
      <td className="whitespace-nowrap tabular-nums">{formatSize(item.sizeBytes)}</td>
      <td><PillList items={view.audioTracks} empty={view.audio} /></td>
      <td><PillList items={view.subtitleTracks} empty={view.subtitles} /></td>
      <td><PlanStatus lines={view.planLines} /></td>
      {encodeTarget ? (
        <td className="align-top">
          {item.type === "movie" ? (
            <MovieEncodeTarget
              item={item}
              onDone={onDone}
              onHealth={onHealth}
              houseVideoTarget={houseVideoTarget}
              av1Available={av1Available}
            />
          ) : null}
        </td>
      ) : null}
      <td className="align-top">
        <RowActions item={item} onDone={onDone} onHealth={onHealth} />
      </td>
    </>
  );
}

function MovieEncodeTarget({
  item,
  onDone,
  onHealth,
  houseVideoTarget,
  av1Available,
}: {
  item: LibraryRow;
  onDone: () => void;
  onHealth?: (health: { healthyCount: number; suggestionCount: number }) => void;
  houseVideoTarget: "hevc" | "av1";
  av1Available: boolean;
}) {
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  return (
    <div className="flex w-56 max-w-full flex-col items-start gap-1">
      <EncodeTargetSelect
        showLabel={false}
        value={item.videoTarget ?? null}
        houseTarget={houseVideoTarget}
        av1Available={av1Available}
        onChange={(videoTarget) => {
          void api.setItemVideoTarget(item.id, videoTarget).then((result) => {
            setNote({ tone: "ok", text: "Encode target saved." });
            onHealth?.(result);
            onDone();
          }).catch((error: Error) => setNote({ tone: "bad", text: error.message }));
        }}
      />
      {note ? <ActionNote tone={note.tone}>{note.text}</ActionNote> : null}
    </div>
  );
}
