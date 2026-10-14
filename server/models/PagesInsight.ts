import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BelongsTo,
  Column,
  DataType,
  Default,
  ForeignKey,
  Table,
} from "sequelize-typescript";
import PagesSite from "./PagesSite";
import IdModel from "./base/IdModel";

export enum PagesInsightPeriod {
  Day = "day",
  Week = "week",
}

@Table({
  tableName: "pages_insights",
  modelName: "pagesInsight",
  indexes: [
    {
      fields: ["siteId", "pageKey", "date", "period"],
      unique: true,
    },
  ],
})
class PagesInsight extends IdModel<
  InferAttributes<PagesInsight>,
  Partial<InferCreationAttributes<PagesInsight>>
> {
  /** The page path, or an empty string for the site-wide total. */
  @Column(DataType.STRING(512))
  pageKey: string;

  @Column(DataType.DATEONLY)
  date: string;

  @Column(DataType.STRING)
  period: PagesInsightPeriod;

  @Default(0)
  @Column(DataType.INTEGER)
  viewCount: number;

  @Default(0)
  @Column(DataType.INTEGER)
  visitorCount: number;

  @Default(0)
  @Column(DataType.INTEGER)
  totalActiveSeconds: number;

  @Default({})
  @Column(DataType.JSONB)
  timeHistogram: Record<string, number>;

  // associations

  @BelongsTo(() => PagesSite, "siteId")
  site: PagesSite;

  @ForeignKey(() => PagesSite)
  @Column(DataType.UUID)
  siteId: string;
}

export default PagesInsight;
