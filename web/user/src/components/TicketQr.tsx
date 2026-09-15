import { toDataURL } from "qrcode";
import { useEffect, useState } from "react";
import styles from "./TicketQr.module.css";

/** 参赛凭证二维码：内容为 ticketCode，本地生成，不请求网络 */
export function TicketQr({ code, label }: { code: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    toDataURL(code, { errorCorrectionLevel: "M", margin: 1, width: 240 })
      .then((url) => {
        if (active) {
          setSrc(url);
        }
      })
      .catch(() => {
        if (active) {
          setSrc(null);
        }
      });
    return () => {
      active = false;
    };
  }, [code]);

  if (!src) {
    return <div className={styles.placeholder} aria-busy="true" />;
  }
  return (
    <img
      data-testid="order-ticket-qr"
      data-ticket-code={code}
      className={styles.qr}
      src={src}
      alt={label}
      width={240}
      height={240}
    />
  );
}
