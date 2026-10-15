import { useEffect, useMemo, useReducer } from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import {
  formatDuration,
  insightsLoadReducer,
  insightsViewState,
  normaliseSeries,
  pageLink,
} from "../insights";
import { loadInsights } from "../pagesApi";
import type { PagesSiteData } from "../types";

interface Props {
  site: PagesSiteData;
  /** Opens the site's Publish dialog; used when measurement needs a republish. */
  onPublish: () => void;
}

/**
 * Shows how a gated site is read: views, visitors and time on page by day or
 * week, and the top pages. Everything shown is an anonymous aggregate.
 */
export function InsightsDialog({ site, onPublish }: Props) {
  const { t } = useTranslation();
  const [load, dispatch] = useReducer(insightsLoadReducer, {
    days: 30,
    period: "day",
    reload: 0,
    status: "loading",
    data: null,
  });
  const { days, period, reload, data } = load;
  const failed = load.status === "error";

  useEffect(() => {
    // Ignore a response that arrives after the options changed again.
    let current = true;
    loadInsights({ id: site.id, period, days })
      .then((result) => current && dispatch({ type: "loaded", data: result }))
      .catch(() => current && dispatch({ type: "failed" }));
    return () => {
      current = false;
    };
  }, [site.id, period, days, reload]);

  const bars = useMemo(() => normaliseSeries(data?.series ?? []), [data]);
  const state = data ? insightsViewState(site, data) : null;
  const isWeek = period === "week";

  return (
    <Flex column gap={16}>
      <Flex gap={16} wrap>
        <Group role="group" aria-label={t("Range")}>
          {([7, 30, 90] as const).map((value) => (
            <Button
              key={value}
              type="button"
              neutral
              aria-pressed={days === value}
              onClick={() => dispatch({ type: "choose", days: value })}
            >
              {t("{{ count }} days", { count: value })}
            </Button>
          ))}
        </Group>
        <Group role="group" aria-label={t("Group by")}>
          <Button
            type="button"
            neutral
            aria-pressed={!isWeek}
            onClick={() => dispatch({ type: "choose", period: "day" })}
          >
            {t("Day")}
          </Button>
          <Button
            type="button"
            neutral
            aria-pressed={isWeek}
            onClick={() => dispatch({ type: "choose", period: "week" })}
          >
            {t("Week")}
          </Button>
        </Group>
      </Flex>

      {failed ? (
        <div role="alert">
          <Text as="p" type="danger">
            {t("Could not load insights.")}
          </Text>
          <Button
            type="button"
            neutral
            onClick={() => dispatch({ type: "retry" })}
          >
            {t("Try again")}
          </Button>
        </div>
      ) : !data || !state ? (
        <Text as="p" type="secondary" role="status">
          {`${t("Loading")}…`}
        </Text>
      ) : state === "never-published" ? (
        <Text as="p" type="secondary">
          {t(
            "This site has not been published yet. Publish it to start measuring."
          )}
        </Text>
      ) : (
        <>
          {!data.measurementEnabled && (
            <Notice role="note">
              <Text as="p">
                {state === "measurement-off"
                  ? t(
                      "Measurement is off for this site, so no visits are recorded."
                    )
                  : t(
                      "Measurement is now off. New visits are not recorded; earlier history is shown."
                    )}{" "}
                {t(
                  "Turning it on requires republishing the site so the measurement script is added to its pages."
                )}
              </Text>
              <Button type="button" neutral onClick={onPublish}>
                {`${site.status === "published" ? t("Republish") : t("Publish")}…`}
              </Button>
            </Notice>
          )}
          {state === "no-data" && (
            <Text as="p" type="secondary">
              {t(
                "No visits recorded yet. Views appear here within moments of a page being opened."
              )}
            </Text>
          )}
          {(state === "data" || state === "no-data") && (
            <>
              <Tiles>
                <Tile>
                  <dt>{t("Views")}</dt>
                  <dd>{data.totals.views}</dd>
                </Tile>
                <Tile>
                  <dt>{t("Visitors")}</dt>
                  <dd>
                    {data.totals.visitorsApproximate ? "≈ " : ""}
                    {data.totals.visitors}
                  </dd>
                </Tile>
                <Tile>
                  <dt>{t("Average time on page")}</dt>
                  <dd>{formatDuration(data.totals.averageSeconds)}</dd>
                </Tile>
                <Tile>
                  <dt>{t("Median time on page")}</dt>
                  <dd>≈ {formatDuration(data.totals.medianSeconds)}</dd>
                </Tile>
              </Tiles>
              {data.totals.visitorsApproximate && (
                <Text as="p" type="tertiary" size="small">
                  {t(
                    "Visitors for this range are summed from {{ period }} counts, so someone who came on several {{ period }}s is counted more than once.",
                    { period: isWeek ? t("week") : t("day") }
                  )}
                </Text>
              )}

              <section aria-label={t("Views per period")}>
                <Bars aria-hidden="true">
                  {bars.map((bar) => (
                    <Bar
                      key={bar.date}
                      title={`${bar.date}: ${bar.views}`}
                      style={{ height: `${Math.round(bar.ratio * 100)}%` }}
                    />
                  ))}
                </Bars>
                <Axis aria-hidden="true">
                  <span>{data.from}</span>
                  <span>{data.to}</span>
                </Axis>
                <details>
                  <summary>{t("Show data table")}</summary>
                  <DataTable>
                    <caption>{t("Views per period")}</caption>
                    <thead>
                      <tr>
                        <th scope="col">
                          {isWeek ? t("Week starting") : t("Date")}
                        </th>
                        <th scope="col">{t("Views")}</th>
                        <th scope="col">{t("Visitors")}</th>
                        <th scope="col">{t("Active time")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.series.map((point) => (
                        <tr key={point.date}>
                          <th scope="row">{point.date}</th>
                          <td>{point.views}</td>
                          <td>{point.visitors}</td>
                          <td>{formatDuration(point.activeSeconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                </details>
              </section>

              <section aria-label={t("Top pages")}>
                <Text as="h3" weight="bold">
                  {t("Top pages")}
                </Text>
                {data.pages.length === 0 ? (
                  <Text as="p" type="secondary">
                    {t("No page views in this range.")}
                  </Text>
                ) : (
                  <DataTable>
                    <thead>
                      <tr>
                        <th scope="col">{t("Page")}</th>
                        <th scope="col">{t("Views")}</th>
                        <th scope="col">{t("Visitors")}</th>
                        <th scope="col">{t("Average time")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.pages.map((page) => {
                        const href = pageLink(site.publishedUrl, page.pageKey);
                        return (
                          <tr key={page.pageKey}>
                            <th scope="row">
                              {href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {page.title}
                                </a>
                              ) : (
                                page.title
                              )}
                              {page.title !== page.pageKey && (
                                <Text as="p" type="tertiary" size="small">
                                  {page.pageKey}
                                </Text>
                              )}
                            </th>
                            <td>{page.views}</td>
                            <td>{page.visitors}</td>
                            <td>{formatDuration(page.averageSeconds)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </DataTable>
                )}
              </section>
            </>
          )}
        </>
      )}

      <Definitions>
        <Text as="h3" weight="bold">
          {t("What these numbers mean")}
        </Text>
        <ul>
          <li>
            {t("A view is one page opened and unlocked in a browser tab.")}
          </li>
          <li>
            {t(
              "Visitors are distinct browser tab sessions, not people, because everyone shares one code in this release."
            )}
          </li>
          <li>
            {t(
              "Time on page counts only seconds the tab was visible and the visitor had interacted in the last 30 seconds, so short or background visits are undercounted."
            )}
          </li>
          <li>{t("The median is approximate.")}</li>
        </ul>
        <Text as="p" type="tertiary" size="small">
          {t(
            "No cookies are set and no IP addresses are stored. Country is not shown in this release. Times are in UTC."
          )}
        </Text>
      </Definitions>
    </Flex>
  );
}

const Group = styled.div`
  display: flex;
  gap: 4px;
`;

const Notice = styled.div`
  padding: 12px;
  border-radius: 8px;
  background: ${s("backgroundSecondary")};
`;

const Tiles = styled.dl`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  margin: 0;
`;

const Tile = styled.div`
  padding: 12px;
  border-radius: 8px;
  background: ${s("backgroundSecondary")};

  dt {
    font-size: 13px;
    color: ${s("textTertiary")};
  }

  dd {
    margin: 4px 0 0;
    font-size: 24px;
    font-weight: 600;
  }
`;

const Bars = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 120px;
  border-bottom: 1px solid ${s("divider")};
`;

const Bar = styled.div`
  flex: 1;
  min-width: 1px;
  background: ${s("accent")};
  border-radius: 2px 2px 0 0;
`;

const Axis = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: ${s("textTertiary")};
`;

const DataTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;

  caption {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  th,
  td {
    padding: 6px 8px;
    text-align: left;
    font-weight: normal;
    border-bottom: 1px solid ${s("divider")};
  }

  thead th {
    color: ${s("textTertiary")};
  }
`;

const Definitions = styled.div`
  ul {
    margin: 4px 0 8px;
    padding-left: 20px;
    color: ${s("textSecondary")};
  }
`;
