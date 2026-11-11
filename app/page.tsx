export default function Home() {
  return (
    <main>
      <span className="tag">Private beta</span>
      <h1>Casa No Pasa</h1>
      <p className="lead">No dejamos pasar ni una casa.</p>
      <ol className="steps">
        <li>Send the bot a listing: a link, the ad text or a screenshot from Idealista, Instagram or a group.</li>
        <li>In under a minute you see if it is a real long-term flat, if it fits, which red flags it carries, and a ready reply in Spanish, Catalan or English.</li>
        <li>You send the reply yourself, with an optional expiring link to your tenant file. We never send, apply or pay for you.</li>
      </ol>
      <p>Access is by invitation for now.</p>
      <p className="foot">
        <a href="/privacy">Privacy</a>
      </p>
    </main>
  );
}
