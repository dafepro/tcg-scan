import { Layers3 } from "lucide-react";
import { useState } from "react";
import type { Card } from "../types";
export default function CardImage({
  card,
  className = "",
}: {
  card: Card;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return card.imageUrl && !failed ? (
    <img
      className={`card-art ${className}`}
      src={card.imageUrl}
      alt={card.name}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <div
      className={`card-art art-placeholder ${card.game} ${className}`}
      role="img"
      aria-label={`${card.name}, card art unavailable`}
    >
      <Layers3 size={28} />
      <span>{card.name}</span>
      <small>{card.setCode || "TCG SCAN"}</small>
    </div>
  );
}
