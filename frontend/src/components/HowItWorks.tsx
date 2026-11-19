/** The three steps behind "How it works". */
export function HowItWorks() {
  return (
    <ol className="steps">
      <li>
        <em aria-hidden="true">1</em>
        <span>
          We check <b>every Real auction</b> against recent sales of the same card.
        </span>
      </li>
      <li>
        <em aria-hidden="true">2</em>
        <span>
          The best ones show here, the most left after fees first. <b>Tap one to open it in Real.</b>
        </span>
      </li>
      <li>
        <em aria-hidden="true">3</em>
        <span>
          Bid the <b>“to start”</b> price to start a 10-min countdown. Others can still outbid you.
        </span>
      </li>
    </ol>
  );
}
