export interface GetRecordInput {
  /**
   * The ID of the base
   */
  baseId: string;
  /**
   * The name or id of the table
   */
  tableIdOrName: string;
  /**
   * The ID of the record
   */
  recordId: string;
}


export interface GetRecordOutput {
  /**
   * When the record was created
   */
  createdTime: string;
  /**
   * All of the fields that are in this record
   */
  fields: {
    [k: string]: unknown;
  };
  /**
   * The record id
   */
  id: string;
}
