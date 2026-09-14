import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import styles from "../pages/Page.module.css";

export function QueryState<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  const { t } = useTranslation("common");

  if (query.isPending) {
    return <p className={styles.muted}>{t("state.loading")}</p>;
  }
  if (query.isError) {
    return (
      <div className={styles.error} role="alert">
        <p>{t("state.error")}</p>
        <button type="button" className={styles.retry} onClick={() => void query.refetch()}>
          {t("action.retry")}
        </button>
      </div>
    );
  }
  return <>{children(query.data)}</>;
}
