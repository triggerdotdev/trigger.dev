import type { RESEND_ERROR_CODE_KEY } from "resend/build/src/interfaces";
import type {RESEND_ERROR_CODE_NUMBER}  from "resend/build/src/interfaces";


interface ErrorResponse extends Error {
        message: string;
        status: RESEND_ERROR_CODE_NUMBER;
        type: RESEND_ERROR_CODE_KEY;
        response: {
            headers: { [key: string]: string };
          };
}

export type { ErrorResponse };